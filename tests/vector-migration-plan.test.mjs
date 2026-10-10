import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION,
  makeV2MovieDocument } from "../lib/vector-schema.mjs";
import { LEGACY_MIGRATION_RECORDS, V2_LIVE_VERIFICATION_CHECKS,
  localVectorValues, matchesExpectedDocument, parseMigrationArgs,
  planV2Migration } from "../lib/vector-migration-plan.mjs";

const vector = Object.freeze([1, ...new Array(LOCAL_DIMENSIONS - 1).fill(0)]);
const provider = Object.freeze({ id: "local", modelId: LOCAL_MODEL_ID,
  modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS });
const movies = Array.from({ length: LEGACY_MIGRATION_RECORDS }, (_, index) => ({
  id: `movie_${index.toString(16).padStart(20, "0")}`,
  title: `Film ${index}`, year: "2024", genre: index === 0 ? "" : "Drama",
  plot: `This is the complete original story for film ${index}, with enough words to validate the movie record. `.repeat(3),
  source_url: `https://en.wikipedia.org/wiki/Film_${index}`,
}));

function cacheFor(movie) {
  const identity = makeCacheIdentity({ recordId: movie.id,
    normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  const chunks = [{ index: 0, coreStart: 0, coreEnd: movie.plot.length,
    spanStart: 0, inputTokens: 20, weight: movie.plot.length }];
  const payload = { identity, chunkCount: 1, chunks, vector };
  const entry = { ...payload,
    integrityHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
  return { identity, cached: { status: "hit", entry } };
}

const cacheById = new Map(movies.map((movie) => [movie.id, cacheFor(movie)]));
const expectedDocs = movies.map((movie) => {
  const cache = cacheById.get(movie.id);
  return makeV2MovieDocument(movie, { id: movie.id,
    vector: cache.cached.entry.vector, sourceHash: cache.identity.sourceHash,
    chunkCount: 1, chunks: cache.cached.entry.chunks,
    provenance: cache.identity, cacheIntegrityHash: cache.cached.entry.integrityHash });
});

function mockDb({ legacyDocs = expectedDocs, destinationDocs = null,
  destinationDefinition = V2_COLLECTION_DEFINITION } = {}) {
  const calls = { reads: 0, writes: 0 };
  const legacy = {
    async countDocuments() { calls.reads += 1; return legacyDocs.length; },
    find() { calls.reads += 1; return { async toArray() { return legacyDocs.map((doc) => ({
      ...doc, $vector: doc.$vector instanceof DataAPIVector ? doc.$vector : new DataAPIVector(doc.$vector),
    })); } }; },
  };
  const destination = {
    async findOne({ _id }) { calls.reads += 1;
      return destinationDocs?.find((item) => item._id === _id) ?? null; },
  };
  for (const collection of [legacy, destination]) {
    for (const method of ["insertOne", "replaceOne", "updateOne", "deleteOne", "drop"]) {
      collection[method] = async () => { calls.writes += 1; throw new Error("write forbidden"); };
    }
  }
  const db = {
    async listCollections() { calls.reads += 1;
      return [{ name: LOCAL_COLLECTION, definition: { vector: { dimension: 384, metric: "cosine" } } },
        ...(destinationDocs === null ? [] : [{ name: V2_COLLECTION, definition: destinationDefinition }])]; },
    collection(name) {
      if (name === LOCAL_COLLECTION) return legacy;
      if (name === V2_COLLECTION) return destination;
      throw new Error("unexpected collection");
    },
    async createCollection() { calls.writes += 1; throw new Error("write forbidden"); },
    async dropCollection() { calls.writes += 1; throw new Error("write forbidden"); },
  };
  return { db, calls };
}

const inspectCache = async (movie) => cacheById.get(movie.id);
const plan = (db, options = {}) => planV2Migration({ db, movies, provider,
  inspectCache, expectedDatasetCount: movies.length, ...options });

test("dry-run is default; apply requires both exact flags and a separate milestone gate", () => {
  assert.deepEqual(parseMigrationArgs([]), { mode: "dry-run" });
  assert.deepEqual(parseMigrationArgs(["--dry-run"]), { mode: "dry-run" });
  assert.deepEqual(parseMigrationArgs(["--apply", "--confirm-v2-migration"]), { mode: "apply" });
  assert.deepEqual(parseMigrationArgs(["--confirm-v2-migration", "--apply"]), { mode: "apply" });
  for (const args of [["--apply"], ["--confirm-v2-migration"],
    ["--dry-run", "--apply"], ["--limit", "100"],
    ["--apply", "--confirm-v2-migration", "--dry-run"]]) {
    assert.throws(() => parseMigrationArgs(args), /Live execution remains gated/);
  }
});

test("ten-record dry-run verifies legacy documents and plans no writes or inference", async () => {
  const { db, calls } = mockDb();
  const result = await plan(db);
  assert.equal(result.legacyCount, 10);
  assert.equal(result.records.length, 10);
  assert.equal(result.destinationState, "missing");
  assert.deepEqual(result.counts, { copyAfterApproval: 10, alreadyMatching: 0, conflicts: 0 });
  assert.ok(result.records.every((item) => item.destinationStatus === "copy-after-approval" &&
    item.readbackAfterFutureWrite && /^[a-f0-9]{64}$/u.test(item.sourceHash)));
  assert.deepEqual(result.records.map((item) => item.id), movies.map((item) => item.id));
  assert.equal(result.records[0].id, movies[0].id);
  assert.equal(result.proposedDefinition, V2_COLLECTION_DEFINITION);
  assert.equal(result.databaseWrites, 0);
  assert.equal(result.inferenceCalls, 0);
  assert.equal(calls.writes, 0);
  assert.ok(calls.reads > 0);
});

test("DataAPIVector conversion and vector integrity are checked", async () => {
  const wrapped = new DataAPIVector(vector);
  assert.deepEqual(localVectorValues(wrapped), vector);
  assert.ok(matchesExpectedDocument({ ...expectedDocs[0], $vector: wrapped }, expectedDocs[0]));
  assert.throws(() => localVectorValues(new DataAPIVector([1, 0])), /dimensions/);
  assert.throws(() => localVectorValues(new Array(384).fill(0)), /unit L2 norm/);
  const malformed = expectedDocs.map((doc) => ({ ...doc }));
  malformed[0].$vector = [1, 0];
  await assert.rejects(plan(mockDb({ legacyDocs: malformed }).db), /Legacy provenance or vector is invalid/);
});

test("wrong source hash, metadata, or provider cannot enter the migration plan", async () => {
  for (const change of [{ content_hash: "0".repeat(64) }, { plot: "truncated" },
    { embedding_provider: "openai" }, { model_revision: "wrong" }]) {
    const legacyDocs = expectedDocs.map((doc, index) => index === 0 ? { ...doc, ...change } : doc);
    await assert.rejects(plan(mockDb({ legacyDocs }).db), /Legacy metadata, hash, or vector differs/);
  }
  await assert.rejects(plan(mockDb().db, { provider: { ...provider, id: "openai" } }), /pinned local/);
});

test("matching destination IDs are idempotent; partial results and conflicts are explicit", async () => {
  const destinationDocs = expectedDocs.slice(0, 3).map((doc) => ({ ...doc, $vector: new DataAPIVector(doc.$vector) }));
  destinationDocs.push({ ...expectedDocs[3], title: "unexpected title" });
  const { db, calls } = mockDb({ destinationDocs });
  const result = await plan(db);
  assert.equal(result.destinationState, "compatible");
  assert.deepEqual(result.counts, { copyAfterApproval: 6, alreadyMatching: 3, conflicts: 1 });
  assert.equal(result.hasBlockingRecordConflicts, true);
  assert.equal(result.liveExecutionAvailable, false);
  assert.equal(result.records[3].destinationStatus, "conflict");
  assert.ok(result.records.slice(4).every((item) => item.readbackAfterFutureWrite));
  assert.equal(calls.writes, 0);
});

test("incompatible destination and unexpected legacy inventory fail before writes", async () => {
  const incompatible = mockDb({ destinationDocs: [], destinationDefinition: {
    ...V2_COLLECTION_DEFINITION, indexing: { allow: ["plot"] },
  } });
  await assert.rejects(plan(incompatible.db), /incompatible vector or indexing/);
  assert.equal(incompatible.calls.writes, 0);
  await assert.rejects(plan(mockDb({ legacyDocs: expectedDocs.slice(0, 9) }).db), /exactly ten/);
  const unknown = expectedDocs.map((doc) => ({ ...doc }));
  unknown[0]._id = "movie_ffffffffffffffffffff";
  await assert.rejects(plan(mockDb({ legacyDocs: unknown }).db), /not in the current dataset/);
});

test("dry-run does not claim live verification and protects the legacy collection", async () => {
  const result = await plan(mockDb().db);
  assert.match(result.liveVerification.status, /not evaluated by dry-run/);
  for (const fragment of ["384 dimensions", "_id readback", "genre", "year",
    "content_type", "nearest-neighbor", "legacy count"]) {
    assert.ok(V2_LIVE_VERIFICATION_CHECKS.some((check) => check.includes(fragment)));
  }
  assert.equal(result.legacyCollection, LOCAL_COLLECTION);
  assert.equal(result.destinationCollection, V2_COLLECTION);
  assert.match(result.futureWritePolicy, /read back each result/);
});
