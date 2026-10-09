import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { cacheFilePath, makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { writeCachedEmbedding } from "../lib/embedding-cache.mjs";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { embedMovieLocally, inspectMovieCache, chunkMetadata } from "../lib/movie-embeddings.mjs";
import { makeMovieVectorDocument } from "../lib/movie-vector-store.mjs";
import { deterministicMovieOrder, isRetryableAstraError, parseBatchArgs,
  runControlledBatch, withAstraRetry } from "../lib/batch-ingestion.mjs";
import { loadIngestionCheckpoint, newIngestionCheckpoint, recordCheckpointOutcome,
  writeIngestionCheckpoint } from "../lib/ingestion-checkpoint.mjs";

const first = { id: "movie_11111111111111111111", title: "A film", year: "2024", genre: "Drama",
  plot: "A genuine movie plot with a beginning and a conclusion.", source_url: "https://en.wikipedia.org/wiki/A_film" };
const second = { ...first, id: "movie_22222222222222222222", title: "Another film",
  source_url: "https://en.wikipedia.org/wiki/Another_film" };
const vector = [1, ...new Array(LOCAL_DIMENSIONS - 1).fill(0)];
const datasetHash = "a".repeat(64);
const configHash = "b".repeat(64);
const noDelay = async () => {};

function embeddingFor(movie) {
  const provenance = makeCacheIdentity({ recordId: movie.id,
    normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  const chunks = [{ index: 0, coreStart: 0, coreEnd: movie.plot.length, spanStart: 0,
    inputTokens: 20, weight: movie.plot.length }];
  const payload = { identity: provenance, chunkCount: 1, chunks, vector };
  return { id: movie.id, sourceHash: provenance.sourceHash, vector, chunkCount: 1,
    chunks, provenance, cacheStatus: "hit", cacheIntegrityHash:
      createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function mockCollection(options = {}) {
  const documents = new Map();
  const calls = { reads: 0, writes: 0 };
  let failId = options.failId;
  let uncertainId = options.uncertainId;
  const collection = {
    async findOne({ _id }) {
      calls.reads += 1;
      const document = documents.get(_id);
      return document ? { ...document, $vector: new DataAPIVector(document.$vector) } : null;
    },
    async replaceOne({ _id }, replacement) {
      calls.writes += 1;
      if (_id === failId) throw options.failError ?? new Error("permanent failure");
      documents.set(_id, { _id, ...replacement });
      if (_id === uncertainId) {
        uncertainId = null;
        throw Object.assign(new Error("connection interrupted after write"), { code: "ECONNRESET" });
      }
      return { upsertedCount: 1 };
    },
    async updateOne({ _id }, update) {
      calls.writes += 1;
      documents.set(_id, { ...documents.get(_id), ...update.$set });
      return { matchedCount: 1 };
    },
    async countDocuments({ _id }) { return documents.has(_id) ? 1 : 0; },
  };
  return { collection, documents, calls, setFailId: (id) => { failId = id; } };
}

async function withState(run) {
  const parent = resolve("data/cache");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "batch-test-"));
  try { return await run(join(root, "checkpoint.json")); }
  finally {
    if (!root.startsWith(parent + sep)) throw new Error("Unsafe test cleanup path.");
    await rm(root, { recursive: true, force: true });
  }
}

function options(checkpointPath, collection, movies = [first, second], extra = {}) {
  return { checkpointPath, collection, movies, datasetHash, configHash,
    batchSize: 2, prepareEmbedding: async (movie) => embeddingFor(movie),
    sleep: noDelay, ...extra };
}

test("dry-run is default, unsafe flags and write limits are rejected", async () => {
  assert.equal(parseBatchArgs([]).apply, false);
  assert.equal(parseBatchArgs(["--apply", "--limit", "10", "--batch-size", "3"]).batchSize, 3);
  assert.throws(() => parseBatchArgs(["--apply", "--limit", "11"]), /1..10/);
  assert.throws(() => parseBatchArgs(["--resume"]), /require --apply/);
  assert.throws(() => parseBatchArgs(["--apply", "--dry-run"]), /cannot be combined/);
  const { collection, calls } = mockCollection();
  await withState(async (path) => {
    await assert.rejects(runControlledBatch(options(path, collection, new Array(11).fill(first))), /1 and 10/);
  });
  assert.equal(calls.writes, 0);
});

test("duplicate IDs are rejected before any write", () => withState(async (path) => {
  assert.throws(() => deterministicMovieOrder([first, first], [first]), /Duplicate movie ID/);
  const { collection, calls } = mockCollection();
  await assert.rejects(runControlledBatch(options(path, collection, [first, first])), /duplicate movie IDs/);
  assert.equal(calls.writes, 0);
}));

test("existing unchanged record is skipped; changed plot gets a new vector identity", () => withState(async (path) => {
  const { collection, documents, calls } = mockCollection();
  documents.set(first.id, makeMovieVectorDocument(first, embeddingFor(first)));
  const initial = await runControlledBatch(options(path, collection));
  assert.deepEqual([initial.inserted, initial.skipped, initial.verified], [1, 1, 2]);
  assert.equal(calls.writes, 1);
  const changed = { ...first, plot: "A meaningfully changed genuine source plot." };
  assert.throws(() => makeMovieVectorDocument(changed, embeddingFor(first)), /incompatible/);
  const updated = await runControlledBatch(options(path, collection, [changed], { batchSize: 1 }));
  assert.equal(updated.updated, 1);
  assert.equal(updated.verified, 1);
  assert.equal(documents.get(first.id).content_hash, embeddingFor(changed).sourceHash);
}));

test("partial failure leaves batch incomplete and resume verifies before skipping", () => withState(async (path) => {
  const { collection, calls, setFailId } = mockCollection({ failId: second.id });
  const initial = await runControlledBatch(options(path, collection));
  assert.deepEqual([initial.inserted, initial.failed, initial.verified], [1, 1, 1]);
  assert.deepEqual(initial.completedBatches, []);
  const checkpoint = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(checkpoint.completedBatches, []);
  setFailId(null);
  const resumed = await runControlledBatch(options(path, collection, [first, second], { resume: true }));
  assert.deepEqual([resumed.inserted, resumed.skipped, resumed.failed], [1, 1, 0]);
  assert.deepEqual(resumed.completedBatches, [0]);
  assert.equal(calls.writes, 3);
}));

test("interrupted write is reconciled by remote readback without a duplicate write", () => withState(async (path) => {
  const { collection, calls, documents } = mockCollection({ uncertainId: first.id });
  const result = await runControlledBatch(options(path, collection, [first], { batchSize: 1 }));
  assert.equal(result.reconciled, 1);
  assert.equal(result.verified, 1);
  assert.equal(calls.writes, 1);
  assert.equal(documents.size, 1);
}));

test("retryable connection failures stop after three write attempts", () => withState(async (path) => {
  const error = Object.assign(new Error("network down"), { code: "ECONNRESET" });
  const { collection, calls } = mockCollection({ failId: first.id, failError: error });
  const result = await runControlledBatch(options(path, collection, [first], { batchSize: 1 }));
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].errorKind, "RetryExhaustedError");
  assert.equal(calls.writes, 3);
  assert.equal(isRetryableAstraError(error), true);
  await assert.rejects(withAstraRetry(async () => { throw error; }, { attempts: 2, sleep: noDelay }),
    /exhausted bounded retries/);
}));

test("checkpoint corruption and dataset or configuration changes fail closed", () => withState(async (path) => {
  const expected = { datasetHash, configHash, selectedIds: [first.id], batchSize: 1 };
  await writeFile(path, "{partial", "utf8");
  await assert.rejects(loadIngestionCheckpoint(path, expected, true), /Corrupt ingestion checkpoint JSON/);
  const state = newIngestionCheckpoint(expected);
  recordCheckpointOutcome(state, first.id, { status: "inserted", verified: true,
    sourceHash: embeddingFor(first).sourceHash });
  await writeIngestionCheckpoint(path, state);
  await assert.rejects(loadIngestionCheckpoint(path, { ...expected, datasetHash: "c".repeat(64) }, true), /Incompatible/);
  await assert.rejects(loadIngestionCheckpoint(path, { ...expected, configHash: "d".repeat(64) }, true), /Incompatible/);
  const loaded = await loadIngestionCheckpoint(path, expected, true);
  assert.deepEqual(loaded.state.completedBatches, [0]);
}));

test("checkpoint success never bypasses remote verification", () => withState(async (path) => {
  const { collection, calls, documents } = mockCollection();
  await runControlledBatch(options(path, collection, [first], { batchSize: 1 }));
  documents.delete(first.id);
  const resumed = await runControlledBatch(options(path, collection, [first], { batchSize: 1, resume: true }));
  assert.equal(resumed.inserted, 1);
  assert.equal(resumed.skipped, 0);
  assert.equal(calls.writes, 2);
}));

test("a valid but different stored vector is repaired instead of skipped", () => withState(async (path) => {
  const { collection, calls, documents } = mockCollection();
  await runControlledBatch(options(path, collection, [first], { batchSize: 1 }));
  documents.set(first.id, { ...documents.get(first.id),
    $vector: [0, 1, ...new Array(LOCAL_DIMENSIONS - 2).fill(0)] });
  const resumed = await runControlledBatch(options(path, collection, [first], { batchSize: 1, resume: true }));
  assert.equal(resumed.updated, 1);
  assert.equal(resumed.skipped, 0);
  assert.equal(calls.writes, 2);
}));

test("readback mismatch leaves an incomplete checkpoint and can be repaired on resume", () => withState(async (path) => {
  const { collection, documents, calls } = mockCollection();
  const originalFind = collection.findOne;
  let corruptReadback = true;
  collection.findOne = async (filter, settings) => {
    const document = await originalFind(filter, settings);
    return corruptReadback && document ? { ...document, title: "Wrong title" } : document;
  };
  const initial = await runControlledBatch(options(path, collection, [first], { batchSize: 1 }));
  assert.equal(initial.failed, 1);
  assert.deepEqual(initial.completedBatches, []);
  assert.equal(documents.size, 1);
  corruptReadback = false;
  const resumed = await runControlledBatch(options(path, collection, [first], { batchSize: 1, resume: true }));
  assert.equal(resumed.skipped, 1);
  assert.equal(resumed.verified, 1);
  assert.equal(calls.writes, 1);
}));

test("stale or absent cache cannot trigger inference without an explicit option", () => withState(async (path) => {
  let inferenceCalls = 0;
  const provider = { id: "local", modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, tokenCounts: async (texts) => texts.map((text) => text.length),
    embedText: async () => { inferenceCalls += 1; throw new Error("inference forbidden"); } };
  const cacheRoot = join(resolve(path, ".."), "embeddings");
  const missing = await inspectMovieCache(first, provider, { cacheRoot });
  assert.equal(missing.cached.status, "miss");
  await assert.rejects(embedMovieLocally(first, provider, { cacheRoot, allowInference: false }), /inference was not enabled/);
  assert.equal(inferenceCalls, 0);
  await writeCachedEmbedding(cacheRoot, missing.identity, chunkMetadata(missing.plan), vector);
  assert.equal((await inspectMovieCache(first, provider, { cacheRoot })).cached.status, "hit");
  const changed = { ...first, plot: "A changed genuine movie plot." };
  assert.equal((await inspectMovieCache(changed, provider, { cacheRoot })).cached.status, "miss");
  await assert.rejects(embedMovieLocally(changed, provider, { cacheRoot, allowInference: false }), /inference was not enabled/);
  await writeFile(cacheFilePath(cacheRoot, missing.identity), "{corrupt", "utf8");
  assert.equal((await inspectMovieCache(first, provider, { cacheRoot })).cached.status, "invalid");
  await assert.rejects(embedMovieLocally(first, provider,
    { cacheRoot, allowInference: true, rejectInvalidCache: true }), /cache is invalid/);
  assert.equal(inferenceCalls, 0);
}));

test("wrong provider, revision, source hash, dimensions and vector payload are rejected", () => {
  const valid = embeddingFor(first);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, provenance: { ...valid.provenance, providerId: "openai" } }), /incompatible/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, provenance: { ...valid.provenance, modelRevision: "other" } }), /incompatible/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, sourceHash: "a".repeat(64) }), /incompatible/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, vector: [1] }), /dimensions/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, vector: [0, ...valid.vector.slice(1)] }), /unit L2 norm/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, vector: [0.5, ...valid.vector.slice(1)] }), /unit L2 norm/);
  assert.throws(() => makeMovieVectorDocument(first, { ...valid, cacheIntegrityHash: "0".repeat(64) }), /cache integrity/);
});
