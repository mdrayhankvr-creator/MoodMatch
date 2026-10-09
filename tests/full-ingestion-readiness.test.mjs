import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { datasetFingerprint } from "../lib/ingestion-checkpoint.mjs";
import { parseBatchArgs } from "../lib/batch-ingestion.mjs";
import { LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";
import { assertFullExecutionDisabled, buildFullReadinessPlan,
  createFullCheckpointPreview, fullConfigurationFingerprint, inspectRemoteReadOnly,
  parsePreflightArgs, planFullBatches, previewFullResume,
  simulateFullIngestionMock, validateFullDataset } from "../lib/full-ingestion-readiness.mjs";

const provider = Object.freeze({ id: "local", modelId: LOCAL_MODEL_ID,
  modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
  embedText: () => { throw new Error("Inference must never run in preflight."); } });
const vector = [1, ...new Array(LOCAL_DIMENSIONS - 1).fill(0)];
const datasetHash = "a".repeat(64);

function movie(index) {
  return { id: `movie_${index.toString(16).padStart(20, "0")}`,
    title: `Fixture ${index}`, year: "2024", genre: "Drama",
    plot: "A complete film story follows several people through a difficult journey and a clear ending. ".repeat(3),
    source_url: `https://en.wikipedia.org/wiki/Fixture_${index}` };
}

function mockInspection(statuses = new Map()) {
  return async (item) => {
    const identity = makeCacheIdentity({ recordId: item.id,
      normalizedText: buildMovieEmbeddingInput(item), providerId: "local",
      modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
      dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
    const chunks = [{ index: 0, coreStart: 0, coreEnd: item.plot.length,
      spanStart: 0, inputTokens: 40, weight: item.plot.length }];
    const payload = { identity, chunkCount: 1, chunks, vector };
    const entry = { ...payload, integrityHash: createHash("sha256")
      .update(JSON.stringify(payload)).digest("hex") };
    const status = statuses.get(item.id) ?? "miss";
    return { identity, plan: { fullText: buildMovieEmbeddingInput(item), chunks },
      cached: status === "hit" ? { status, entry } : { status } };
  };
}

async function plan(movies, extra = {}) {
  return buildFullReadinessPlan({ movies, priorityMovies: movies.slice(0, 1),
    provider, datasetHash, expectedCount: movies.length,
    inspectCache: mockInspection(extra.statuses), detectStale: async (identity) =>
      extra.staleIds?.has(identity.recordId) ?? false, ...extra });
}

test("full planner validates all IDs and source identities while reporting optional metadata gaps", () => {
  const first = movie(1);
  const second = { ...movie(2), genre: "" };
  assert.deepEqual(validateFullDataset([first, second], 2), {
    records: 2, uniqueIds: 2, uniqueSources: 2, missingGenre: 1, missingYear: 0 });
  assert.throws(() => validateFullDataset([first, first], 2), /Duplicate ID/);
  assert.throws(() => validateFullDataset([first, { ...second, source_url: first.source_url }], 2), /duplicate source identity/i);
  assert.throws(() => validateFullDataset([first], 2), /Expected 2/);
});

test("the planner distinguishes reusable, missing, stale, and invalid cache entries", async () => {
  const movies = [movie(1), movie(2), movie(3), movie(4)];
  const statuses = new Map([[movies[0].id, "hit"], [movies[2].id, "invalid"]]);
  const result = await plan(movies, { statuses, staleIds: new Set([movies[3].id]) });
  assert.deepEqual(result.coverage, { reusable: 1, missing: 1, stale: 1, invalid: 1,
    totalChunks: 4, inferenceRecords: 3, inferenceChunks: 3 });
  assert.equal(result.expectedDocuments.size, 1);
  assert.equal(result.expectedDocuments.get(movies[0].id).content_hash,
    result.records.find((item) => item.id === movies[0].id).sourceHash);
  assert.equal(result.scheduling.batches.length, 1);
});

test("changed dataset bytes and configuration invalidate resume planning", async () => {
  const root = resolve("data/cache");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "preflight-test-"));
  try {
    const file = join(directory, "movies.csv");
    await writeFile(file, "first", "utf8");
    const firstHash = await datasetFingerprint(file);
    await writeFile(file, "second", "utf8");
    assert.notEqual(await datasetFingerprint(file), firstHash);
  } finally {
    assert.ok(directory.startsWith(root + sep));
    await rm(directory, { recursive: true, force: true });
  }
  assert.notEqual(fullConfigurationFingerprint({ batchSize: 10 }),
    fullConfigurationFingerprint({ batchSize: 5 }));
  const movies = [movie(1), movie(2)];
  await assert.rejects(plan(movies, { provider: { ...provider, modelRevision: "other" } }), /pinned local embedding provider/);
  const result = await plan(movies);
  const checkpoint = createFullCheckpointPreview(result);
  checkpoint.records[movies[0].id] = { status: "verified" };
  checkpoint.records[movies[1].id] = { status: "write-uncertain" };
  const resumed = previewFullResume(result, checkpoint);
  assert.equal(resumed.safeToSkipWithoutRemoteRead, 0);
  assert.equal(resumed.remoteReconciliationRequired.length, 2);
  assert.throws(() => previewFullResume(result, { ...checkpoint, datasetHash: "b".repeat(64) }), /Incompatible/);
  assert.throws(() => previewFullResume(result, { ...checkpoint, configHash: "b".repeat(64) }), /Incompatible/);
});

test("a read-only remote inventory verifies cached records and detects missing records", async () => {
  const movies = [movie(1), movie(2)];
  const result = await plan(movies, { statuses: new Map([[movies[0].id, "hit"]]) });
  const stored = result.expectedDocuments.get(movies[0].id);
  let writes = 0;
  const collection = {
    async countDocuments(filter) { return filter._id ? Number(filter._id === stored._id) : 1; },
    find() { return { async toArray() { return [stored]; } }; },
    async findOne({ _id }) { return _id === stored._id ? stored : null; },
    async replaceOne() { writes += 1; throw new Error("write forbidden"); },
  };
  const db = { async listCollections() { return [{ name: LOCAL_COLLECTION,
    definition: { vector: { dimension: 384, metric: "cosine" } } }]; },
    collection() { return collection; } };
  const remote = await inspectRemoteReadOnly(db, result);
  assert.deepEqual([remote.totalRemoteRecords, remote.verified,
    remote.missingDatasetRecords, remote.potentialWritesAfterApproval], [1, 1, 1, 1]);
  assert.equal(writes, 0);
  const incompatible = { ...db, async listCollections() { return [{ name: LOCAL_COLLECTION,
    definition: { vector: { dimension: 1536, metric: "cosine" } } }]; } };
  await assert.rejects(inspectRemoteReadOnly(incompatible, result), /incompatible vector dimensions/);
  assert.equal(writes, 0);
});

test("1100-record mock rehearsal is bounded and recovers uncertain writes and rate limits", async () => {
  const movies = Array.from({ length: 1100 }, (_, index) => movie(index + 1));
  const result = await plan(movies);
  assert.equal(result.scheduling.batches.length, 110);
  const orderedIds = result.records.map((item) => item.id);
  const checkpoint = createFullCheckpointPreview(result);
  checkpoint.records[orderedIds[0]] = { status: "verified" };
  checkpoint.records[orderedIds[1]] = { status: "write-uncertain" };
  const rehearsal = simulateFullIngestionMock(result, {
    checkpoint, existingIds: orderedIds.slice(0, 10),
    rateLimitedIds: [orderedIds[10]], uncertainIds: [orderedIds[11]],
    persistentRateLimitIds: [orderedIds[12]], permanentFailureIds: [orderedIds[13]],
  });
  assert.deepEqual([rehearsal.processed, rehearsal.databaseWrites, rehearsal.inferenceCalls], [1100, 0, 0]);
  assert.deepEqual([rehearsal.counters.unchanged, rehearsal.counters.reconciled,
    rehearsal.counters.failed, rehearsal.counters.inserted], [10, 1, 2, 1087]);
  assert.equal(rehearsal.counters.rateLimitRetries, 3);
  assert.deepEqual(rehearsal.recoverableFailureIds, [orderedIds[12], orderedIds[13]]);
  assert.equal(rehearsal.completedBatches.length, 109);
  assert.equal(rehearsal.records[0].resumeReconciliationRequired, true);
  assert.equal(rehearsal.records[1].resumeReconciliationRequired, true);
});

test("full execution stays unavailable and the M6B sample cap remains ten", () => {
  assert.deepEqual(parsePreflightArgs([]), { remoteReadOnly: false });
  assert.deepEqual(parsePreflightArgs(["--remote-read-only"]), { remoteReadOnly: true });
  assert.throws(() => parsePreflightArgs(["--apply"]), /Full-dataset execution is disabled/);
  assert.throws(() => parsePreflightArgs(["--full-run"]), /Full-dataset execution is disabled/);
  assert.throws(assertFullExecutionDisabled, /Full-dataset execution is disabled/);
  assert.throws(() => parseBatchArgs(["--apply", "--limit", "11"]), /1..10/);
  assert.throws(() => planFullBatches(["a"], { batchSize: 11 }), /batch size 1..10/);
  assert.throws(() => planFullBatches(["a"], { concurrency: 3 }), /concurrency 1..2/);
});
