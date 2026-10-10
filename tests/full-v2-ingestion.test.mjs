import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { assertFullV2ApplyApproved, executeFullV2Ingestion,
  fullV2ConfigurationFingerprint, insertMissingV2Document,
  loadFullV2Checkpoint, newFullV2Checkpoint, parseFullV2Args,
  reconcileCheckpointWithRemote, reconcileFullV2Inventory,
  recordFullV2Outcome, validateFullV2Checkpoint } from "../lib/full-v2-ingestion.mjs";
import { validateFullDataset } from "../lib/full-ingestion-readiness.mjs";
import { writeIngestionCheckpoint } from "../lib/ingestion-checkpoint.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { EMBEDDING_VERSION } from "../lib/movie-vector-store.mjs";
import { APPROVED_V2_MIGRATION_RECORDS,
  sanitizeMigrationFailure } from "../lib/vector-v2-live-migration.mjs";
import { makeV2MovieDocument, V2_COLLECTION, validateV2MovieDocument } from "../lib/vector-schema.mjs";

const vector = Object.freeze([1, ...new Array(LOCAL_DIMENSIONS - 1).fill(0)]);
const digest = (value) => createHash("sha256").update(value).digest("hex");

function sampleMovie(id = "movie_aaaaaaaaaaaaaaaaaaaa") {
  return { id, title: "Sample film", year: "2020", genre: "Drama",
    plot: "The complete and unchanged sample movie plot.",
    source_url: "https://en.wikipedia.org/wiki/Sample_film" };
}

function embeddingFor(movie, values = vector) {
  const provenance = makeCacheIdentity({ recordId: movie.id,
    normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  const chunks = [{ index: 0, coreStart: 0, coreEnd: movie.plot.length,
    spanStart: 0, inputTokens: 20, weight: movie.plot.length }];
  const payload = { identity: provenance, chunkCount: 1, chunks, vector: values };
  return { id: movie.id, vector: values, sourceHash: provenance.sourceHash,
    provenance, chunkCount: 1, chunks,
    cacheIntegrityHash: digest(JSON.stringify(payload)), inferenceCalls: 0 };
}

function syntheticDataset() {
  const pinned = APPROVED_V2_MIGRATION_RECORDS.map((record) => record.id);
  const extra = Array.from({ length: 1090 }, (_, index) =>
    `movie_${(index + 1).toString(16).padStart(20, "0")}`);
  const movies = [...pinned, ...extra].map((id, index) => ({
    id, title: `Film ${index}`, year: "2020", genre: "Drama",
    plot: `Complete plot for film ${index}.`,
    source_url: `https://en.wikipedia.org/wiki/Synthetic_film_${index}` }));
  const pinnedHashes = new Map(APPROVED_V2_MIGRATION_RECORDS.map(({ id, sourceHash }) =>
    [id, sourceHash]));
  const records = movies.map((movie, index) => ({ id: movie.id,
    sourceHash: pinnedHashes.get(movie.id) ?? digest(movie.id),
    chunks: index % 3 + 1, cache: index < 10 ? "reusable" : "missing" }));
  return { movies, records };
}

function expectedDocument(movie, sourceHash) {
  return { _id: movie.id, content_type: "movie", title: movie.title,
    year: 2020, genre: movie.genre, plot: movie.plot, source_url: movie.source_url,
    content_hash: sourceHash, embedding_provider: "local",
    embedding_model: LOCAL_MODEL_ID, model_revision: LOCAL_MODEL_REVISION,
    embedding_version: EMBEDDING_VERSION, chunk_count: 1, $vector: vector };
}

function mockCollection(documents) {
  const byId = new Map(documents.map((document) => [document._id, document]));
  const calls = { reads: 0, writes: 0 };
  return { calls, collection: {
    async countDocuments(filter) {
      calls.reads += 1;
      return filter._id ? Number(byId.has(filter._id)) : byId.size;
    },
    find() { calls.reads += 1; return { async toArray() {
      return [...byId.values()].map(({ _id, content_hash }) => ({ _id, content_hash }));
    } }; },
    async findOne(filter) {
      calls.reads += 1;
      const document = byId.get(filter._id);
      return document ? { ...document, $vector: new DataAPIVector(document.$vector) } : null;
    },
    async insertOne() { calls.writes += 1; throw new Error("unexpected write"); },
  } };
}

test("real unified source has exactly 1,100 unique movie IDs and source identities", async () => {
  const dataset = validateFullDataset(await readUnifiedMovies());
  assert.deepEqual({ records: dataset.records, uniqueIds: dataset.uniqueIds,
    uniqueSources: dataset.uniqueSources },
  { records: 1100, uniqueIds: 1100, uniqueSources: 1100 });
});

test("full-v2 CLI requires both apply flags and a separate closed gate before DB access", async () => {
  assert.deepEqual(parseFullV2Args([]), { mode: "dry-run" });
  assert.deepEqual(parseFullV2Args(["--dry-run"]), { mode: "dry-run" });
  assert.deepEqual(parseFullV2Args(["--apply", "--confirm-full-ingestion"]), { mode: "apply" });
  for (const flags of [["--apply"], ["--confirm-full-ingestion"],
    ["--apply", "--confirm-v2-migration"], ["--apply", "--apply"]]) {
    assert.throws(() => parseFullV2Args(flags));
  }
  assert.throws(assertFullV2ApplyApproved, /separate hardcoded approval gate is closed/);
  let reads = 0;
  const db = { async listCollections() { reads += 1; return []; } };
  await assert.rejects(executeFullV2Ingestion({ db, movies: [], provider: null }),
    /approval gate is closed/);
  assert.equal(reads, 0);
});

test("separate v2 checkpoint validates source, schema, all IDs, and remote truth", async (t) => {
  const { records } = syntheticDataset();
  const expected = { datasetHash: digest("dataset"),
    configHash: fullV2ConfigurationFingerprint(),
    orderedIds: records.map(({ id }) => id),
    sourceHashes: new Map(records.map(({ id, sourceHash }) => [id, sourceHash])) };
  const state = newFullV2Checkpoint(expected);
  recordFullV2Outcome(state, expected, records[0].id, "matching");
  recordFullV2Outcome(state, expected, records[10].id, "inserted");
  assert.equal(validateFullV2Checkpoint(state, expected), state);
  assert.throws(() => reconcileCheckpointWithRemote(state, new Set([records[0].id])),
    /absent remotely/);
  assert.equal(reconcileCheckpointWithRemote(state,
    new Set([records[0].id, records[10].id])), true);
  for (const changed of [{ ...expected, datasetHash: digest("changed") },
    { ...expected, configHash: digest("schema-changed") },
    { ...expected, orderedIds: [...expected.orderedIds].reverse() }]) {
    assert.throws(() => validateFullV2Checkpoint(state, changed), /Incompatible|corrupt/);
  }
  assert.throws(() => validateFullV2Checkpoint({ ...state,
    records: { ...state.records, movie_ffffffffffffffffffff: {
      status: "inserted", sourceHash: digest("unknown") } } }, expected), /Corrupt/);
  const directory = await mkdtemp(join(tmpdir(), "moodmatch-full-v2-test-"));
  t.after(async () => { if (directory.startsWith(tmpdir())) await rm(directory, { recursive: true }); });
  const path = join(directory, "checkpoint.json");
  assert.equal((await loadFullV2Checkpoint(path, expected)).resumed, false);
  await writeIngestionCheckpoint(path, state);
  const loaded = await loadFullV2Checkpoint(path, expected);
  assert.equal(loaded.resumed, true);
  assert.deepEqual(loaded.state.records, state.records);
});

test("read-only v2 inventory skips ten exact sample records and plans only 1,090 missing IDs", async () => {
  const { movies, records } = syntheticDataset();
  const documents = records.slice(0, 10).map((record, index) =>
    expectedDocument(movies[index], record.sourceHash));
  const { collection, calls } = mockCollection(documents);
  const expectedById = new Map(documents.map((document) => [document._id, document]));
  const result = await reconcileFullV2Inventory({ collection, movies, records,
    makeExpectedDocument: async (movie) => expectedById.get(movie.id) });
  assert.deepEqual(result.counts, { matching: 10, missing: 1090, conflicts: 0 });
  assert.equal(result.expectedInferenceRecords, 1090);
  assert.ok(result.expectedInferenceChunks > 1090);
  assert.ok(result.estimatedMissingDocumentBytes > 0);
  assert.equal(calls.writes, 0);
  assert.ok(calls.reads > 10);
  assert.equal(V2_COLLECTION, "movies_local_384_v2");
});

test("v2 inventory rejects unknown IDs, source hash conflicts, and a missing sample", async () => {
  const { movies, records } = syntheticDataset();
  const documents = records.slice(0, 10).map((record, index) =>
    expectedDocument(movies[index], record.sourceHash));
  const expectedById = new Map(documents.map((document) => [document._id, document]));
  const run = (docs) => reconcileFullV2Inventory({ collection: mockCollection(docs).collection,
    movies, records, makeExpectedDocument: async (movie) => expectedById.get(movie.id) });
  await assert.rejects(run([...documents,
    { ...documents[0], _id: "movie_ffffffffffffffffffff" }]), /unexpected ID/);
  await assert.rejects(run(documents.map((doc, index) => index === 0
    ? { ...doc, content_hash: digest("wrong") } : doc)), /source-hash conflict/);
  await assert.rejects(run(documents.slice(1)), /ten verified v2 sample/);
});

test("a complete 1,100-document inventory has zero pending writes", async () => {
  const { movies, records } = syntheticDataset();
  const documents = records.map((record, index) =>
    expectedDocument(movies[index], record.sourceHash));
  const expectedById = new Map(documents.map((document) => [document._id, document]));
  const { collection, calls } = mockCollection(documents);
  const result = await reconcileFullV2Inventory({ collection, movies, records,
    makeExpectedDocument: async (movie) => expectedById.get(movie.id) });
  assert.deepEqual(result.counts, { matching: 1100, missing: 0, conflicts: 0 });
  assert.equal(result.expectedInferenceChunks, 0);
  assert.equal(calls.writes, 0);
});

test("insert-only writer skips matching records and rejects conflicts without writes", async () => {
  const movie = sampleMovie();
  const expected = makeV2MovieDocument(movie, embeddingFor(movie));
  let inserts = 0;
  const matching = { async findOne() { return { ...expected, $vector: new DataAPIVector(vector) }; },
    async countDocuments() { return 1; },
    async insertOne() { inserts += 1; } };
  assert.equal(await insertMissingV2Document(matching, expected), "matching");
  assert.equal(inserts, 0);
  const conflicting = { ...matching,
    async findOne() { return { ...expected, plot: "changed plot" }; } };
  await assert.rejects(insertMissingV2Document(conflicting, expected), /conflicts/);
  assert.equal(inserts, 0);
});

test("uncertain insert reconciles by bounded exact-ID reads and never retries insertion", async () => {
  const movie = sampleMovie();
  const expected = makeV2MovieDocument(movie, embeddingFor(movie));
  let reads = 0;
  let writes = 0;
  const collection = {
    async findOne() {
      reads += 1;
      return reads < 3 ? null : { ...expected, $vector: new DataAPIVector(vector) };
    },
    async countDocuments() { return 1; },
    async insertOne() { writes += 1; throw new Error("uncertain connection loss"); },
  };
  assert.equal(await insertMissingV2Document(collection, expected,
    { sleep: async () => {} }), "reconciled");
  assert.equal(writes, 1);
  assert.ok(reads <= 4);
});

test("quota or connection failures stop after one insert and bounded read-only probes", async () => {
  const movie = sampleMovie();
  const expected = makeV2MovieDocument(movie, embeddingFor(movie));
  for (const kind of ["quota", "connection"]) {
    let writes = 0;
    let reads = 0;
    const collection = { async findOne() { reads += 1; return null; },
      async insertOne() { writes += 1; throw new Error(kind); } };
    await assert.rejects(insertMissingV2Document(collection, expected,
      { sleep: async () => {} }), (error) => {
      const safe = sanitizeMigrationFailure(error);
      assert.equal(safe.operation, "insertOne");
      assert.doesNotMatch(JSON.stringify(safe), /quota|connection/);
      return true;
    });
    assert.equal(writes, 1);
    assert.ok(reads <= 4);
  }
});

test("local v2 document construction rejects bad dimensions, values, norm and cache checksum", () => {
  const movie = sampleMovie();
  const good = makeV2MovieDocument(movie, embeddingFor(movie));
  assert.equal(good.$vector.length, 384);
  assert.equal(validateV2MovieDocument(good, movie).plotBytes,
    Buffer.byteLength(movie.plot, "utf8"));
  for (const bad of [[1], [Number.NaN, ...new Array(383).fill(0)],
    new Array(384).fill(0)]) {
    assert.throws(() => makeV2MovieDocument(movie, embeddingFor(movie, bad)));
  }
  assert.throws(() => makeV2MovieDocument(movie, {
    ...embeddingFor(movie), cacheIntegrityHash: digest("corrupt") }), /cache integrity/);
});
