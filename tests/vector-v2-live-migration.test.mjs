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
  makeV2MovieDocument, resolveLocalVectorCollection } from "../lib/vector-schema.mjs";
import { parseMigrationArgs, planV2Migration } from "../lib/vector-migration-plan.mjs";
import { assertV2MigrationApproved, ensureV2Collection, executeV2Migration,
  verifyExactV2Document, verifyV2Descriptor, verifyV2Inventory,
  verifyV2LiveState, verifyV2MetadataFilters,
  verifyV2VectorSearch } from "../lib/vector-v2-live-migration.mjs";

const vector = [1, ...new Array(383).fill(0)];
const expected = Array.from({ length: 10 }, (_, index) => ({
  _id: `movie_${index.toString(16).padStart(20, "0")}`,
  content_type: "movie", title: `Film ${index}`, year: 2020 + index,
  genre: index === 0 ? "" : "Drama", plot: `Unabridged plot ${index} `.repeat(500),
  source_url: `https://en.wikipedia.org/wiki/Film_${index}`,
  content_hash: index.toString(16).padStart(64, "0"),
  embedding_provider: "local", embedding_model: "Xenova/all-MiniLM-L6-v2",
  model_revision: "pinned", embedding_version: "v1", chunk_count: 1,
  $vector: vector,
}));
const records = expected.map((doc) => ({ id: doc._id, sourceHash: doc.content_hash }));

function mockCollection(documents = expected) {
  const calls = { writes: 0, reads: 0 };
  const collection = {
    async countDocuments(filter) {
      calls.reads += 1;
      return filter._id ? documents.filter((doc) => doc._id === filter._id).length : documents.length;
    },
    async findOne(filter) {
      calls.reads += 1;
      const doc = documents.find((item) => item._id === filter._id);
      return doc && { ...doc, $vector: new DataAPIVector(doc.$vector) };
    },
    find(filter, options = {}) {
      calls.reads += 1;
      const filtered = documents.filter((doc) => Object.entries(filter).every(([key, value]) => doc[key] === value));
      return { async toArray() {
        return (options.sort ? [...filtered].sort((a, b) => a._id.localeCompare(b._id)) : filtered)
          .slice(0, options.limit ?? filtered.length)
          .map((doc) => options.projection?.$vector ? { ...doc, $vector: new DataAPIVector(doc.$vector) } : { ...doc });
      } };
    },
    async insertOne() { calls.writes += 1; throw new Error("write forbidden"); },
    async replaceOne() { calls.writes += 1; throw new Error("write forbidden"); },
    async deleteOne() { calls.writes += 1; throw new Error("write forbidden"); },
  };
  return { collection, calls };
}

test("hardcoded approval gate rejects direct and CLI-shaped execution before any database access", async () => {
  assert.deepEqual(parseMigrationArgs(["--apply", "--confirm-v2-migration"]), { mode: "apply" });
  assert.throws(assertV2MigrationApproved, /M6D\.3B milestone gate/);
  const calls = { reads: 0, writes: 0 };
  const db = {
    async listCollections() { calls.reads += 1; return []; },
    async createCollection() { calls.writes += 1; throw new Error("write forbidden"); },
  };
  await assert.rejects(ensureV2Collection(db), /M6D\.3B milestone gate/);
  await assert.rejects(executeV2Migration({ db, movies: [], provider: null }), /M6D\.3B milestone gate/);
  assert.deepEqual(calls, { reads: 0, writes: 0 });
});

test("collection definition is client-vector cosine with an explicit safe allowlist", () => {
  assert.equal(V2_COLLECTION, "movies_local_384_v2");
  assert.deepEqual(V2_COLLECTION_DEFINITION.vector, { dimension: 384, metric: "cosine" });
  assert.deepEqual(V2_COLLECTION_DEFINITION.indexing.allow,
    ["$vector", "content_type", "genre", "year", "title", "embedding_provider"]);
  for (const field of ["plot", "source_url", "content_hash"]) {
    assert.ok(!V2_COLLECTION_DEFINITION.indexing.allow.includes(field));
  }
  assert.equal(V2_COLLECTION_DEFINITION.vector.service, undefined);
});

test("descriptor inspection reuses an exact v2 definition and rejects incompatible duplicates", async () => {
  const { collection } = mockCollection();
  const compatible = { listCollections: async () => [
    { name: V2_COLLECTION, definition: V2_COLLECTION_DEFINITION },
  ], collection: () => collection };
  assert.equal(await verifyV2Descriptor(compatible), collection);
  await assert.rejects(verifyV2Descriptor({ ...compatible,
    listCollections: async () => [{ name: V2_COLLECTION,
      definition: { ...V2_COLLECTION_DEFINITION, indexing: { allow: ["plot"] } } }],
  }), /incompatible vector or indexing/);
  await assert.rejects(verifyV2Descriptor({ ...compatible, listCollections: async () => [] }), /missing/);
});

test("inventory verifies ten hashes and safely identifies partial, duplicate, and unknown records", async () => {
  const full = mockCollection();
  assert.deepEqual(await verifyV2Inventory(full.collection, records, { requireComplete: true }),
    { count: 10, hashesVerified: 10 });
  const partial = mockCollection(expected.slice(0, 3));
  assert.deepEqual(await verifyV2Inventory(partial.collection, records),
    { count: 3, hashesVerified: 3 });
  await assert.rejects(verifyV2Inventory(partial.collection, records, { requireComplete: true }),
    /unexpected document count/);
  await assert.rejects(verifyV2Inventory(mockCollection([
    { ...expected[0], _id: "movie_ffffffffffffffffffff", content_hash: undefined },
  ]).collection, records), /unknown ID/);
  await assert.rejects(verifyV2Inventory(mockCollection([
    { ...expected[0], content_hash: "wrong" },
  ]).collection, records), /source hash/);
  await assert.rejects(verifyV2Inventory(mockCollection([expected[0], expected[0]]).collection,
    records), /unknown ID/);
  assert.equal(full.calls.writes + partial.calls.writes, 0);
});

test("exact readback converts DataAPIVector and preserves the complete plot, URL, and identity", async () => {
  const { collection, calls } = mockCollection();
  assert.equal(await verifyExactV2Document(collection, expected[0]), true);
  for (const change of [{ plot: "truncated" }, { source_url: "https://en.wikipedia.org/wiki/Other" },
    { content_hash: "wrong" }, { $vector: [1, 0] }]) {
    await assert.rejects(verifyExactV2Document(mockCollection([
      { ...expected[0], ...change },
    ]).collection, expected[0]), /readback mismatch/);
  }
  assert.equal(calls.writes, 0);
});

test("metadata filters and vector retrieval are checked independently with read-only queries", async () => {
  const { collection, calls } = mockCollection();
  assert.deepEqual(await verifyV2MetadataFilters(collection, expected),
    ["content_type", "genre", "year"]);
  assert.equal(await verifyV2VectorSearch(collection, expected), true);
  assert.equal(calls.writes, 0);
  const ignoresFilters = { find: () => ({ async toArray() {
    return expected.map((doc) => ({ _id: doc._id }));
  } }) };
  await assert.rejects(verifyV2MetadataFilters(ignoresFilters, expected), /genre filter/);
  const broken = mockCollection(expected.slice(1));
  await assert.rejects(verifyV2VectorSearch(broken.collection, expected), /vector similarity/);
});

test("combined live verifier checks all ten documents and detects a changed legacy snapshot", async () => {
  const provider = { id: "local", modelId: LOCAL_MODEL_ID,
    modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS };
  const movies = expected.map((doc) => ({ id: doc._id, title: doc.title,
    year: String(doc.year), genre: doc.genre, plot: doc.plot, source_url: doc.source_url }));
  const caches = new Map(movies.map((movie) => {
    const identity = makeCacheIdentity({ recordId: movie.id,
      normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
      modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
      dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
    const chunks = [{ index: 0, coreStart: 0, coreEnd: movie.plot.length,
      spanStart: 0, inputTokens: 20, weight: movie.plot.length }];
    const payload = { identity, chunkCount: 1, chunks, vector };
    return [movie.id, { identity, cached: { status: "hit", entry: { ...payload,
      integrityHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
    } } }];
  }));
  const inspectCache = async (movie) => caches.get(movie.id);
  const documents = movies.map((movie) => {
    const cache = caches.get(movie.id);
    return makeV2MovieDocument(movie, { id: movie.id, vector,
      sourceHash: cache.identity.sourceHash, chunkCount: 1,
      chunks: cache.cached.entry.chunks, provenance: cache.identity,
      cacheIntegrityHash: cache.cached.entry.integrityHash });
  });
  const legacy = mockCollection(documents);
  const destination = mockCollection(documents);
  const db = {
    async listCollections() { return [
      { name: LOCAL_COLLECTION, definition: { vector: { dimension: 384, metric: "cosine" } } },
      { name: V2_COLLECTION, definition: V2_COLLECTION_DEFINITION },
    ]; },
    collection(name) { return name === LOCAL_COLLECTION ? legacy.collection : destination.collection; },
  };
  const baseline = await planV2Migration({ db, movies, provider, inspectCache,
    expectedDatasetCount: 10 });
  assert.deepEqual(await verifyV2LiveState({ db, movies, provider, inspectCache,
    expectedDatasetCount: 10, baselineSnapshot: baseline.legacySnapshotHash }), {
    documents: 10, hashesVerified: true, completePlotsVerified: true,
    filters: ["content_type", "genre", "year"], vectorSearchVerified: true,
    legacySnapshotUnchanged: true,
  });
  assert.equal(legacy.calls.writes + destination.calls.writes, 0);
  documents[0] = { ...documents[0], plot: "changed" };
  await assert.rejects(verifyV2LiveState({ db, movies, provider, inspectCache,
    expectedDatasetCount: 10, baselineSnapshot: baseline.legacySnapshotHash }), /Legacy metadata/);
});

test("rollback selector stays explicit and defaults to the untouched legacy collection", () => {
  assert.equal(resolveLocalVectorCollection(null), LOCAL_COLLECTION);
  assert.equal(resolveLocalVectorCollection(V2_COLLECTION), V2_COLLECTION);
  assert.throws(() => resolveLocalVectorCollection("unreviewed_collection"), /Unsupported/);
});
