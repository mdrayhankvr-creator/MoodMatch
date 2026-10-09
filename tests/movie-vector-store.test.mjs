import test from "node:test";
import assert from "node:assert/strict";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { createHash } from "node:crypto";
import { makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { validateAstraSettings } from "../lib/astra-runtime.mjs";
import { LOCAL_COLLECTION, initializeMovieCollection, makeMovieVectorDocument, upsertMovieVector,
  verifyMovieVector, ingestMovieBatch, searchMovieVectors } from "../lib/movie-vector-store.mjs";

const movie = Object.freeze({ id: "movie_0123456789abcdef0123", title: "Real title", year: "2024",
  genre: "Drama", plot: "A complete source plot about a real film.",
  source_url: "https://en.wikipedia.org/wiki/Example_film" });
const vector = Object.freeze([1, ...new Array(383).fill(0)]);
function embeddingFor(record) {
  const provenance = makeCacheIdentity({ recordId: record.id,
    normalizedText: buildMovieEmbeddingInput(record), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  const chunks = [{ index: 0, coreStart: 0, coreEnd: record.plot.length, spanStart: 0,
    inputTokens: 20, weight: record.plot.length }];
  const payload = { identity: provenance, chunkCount: chunks.length, chunks, vector };
  return { id: record.id, vector, sourceHash: provenance.sourceHash,
    chunkCount: chunks.length, chunks, provenance, cacheStatus: "hit",
    cacheIntegrityHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}
const embedding = embeddingFor(movie);

function mockDb(options = {}) {
  const documents = new Map();
  const calls = { creates: 0, replaces: 0, updates: 0, reads: 0 };
  let descriptor = options.descriptor ?? null;
  const collection = {
    async findOne({ _id }) {
      calls.reads += 1;
      const doc = documents.get(_id);
      return doc ? { ...doc, $vector: new DataAPIVector(doc.$vector) } : null;
    },
    async replaceOne({ _id }, replacement) {
      calls.replaces += 1;
      if (options.failId === _id) throw new Error("mock write failed");
      documents.set(_id, { _id, ...replacement });
      return { upsertedCount: 1 };
    },
    async updateOne({ _id }, update) {
      calls.updates += 1;
      documents.set(_id, { ...documents.get(_id), ...update.$set });
      return { matchedCount: 1 };
    },
    async countDocuments({ _id }) { return documents.has(_id) ? 1 : 0; },
    find() { return { async toArray() { return [...documents.values()].map((doc) =>
      ({ _id: doc._id, title: doc.title, $similarity: 1 })); } }; },
  };
  const db = {
    async listCollections() { return descriptor ? [descriptor] : []; },
    collection(name) { assert.equal(name, LOCAL_COLLECTION); return collection; },
    async createCollection(name, settings) {
      calls.creates += 1;
      descriptor = { name, definition: settings };
      return collection;
    },
  };
  return { db, collection, documents, calls };
}

test("missing credentials and invalid endpoints fail without printing values", () => {
  assert.throws(() => validateAstraSettings({}), /ASTRA_DB_APPLICATION_TOKEN/);
  assert.throws(() => validateAstraSettings({ ASTRA_DB_APPLICATION_TOKEN: "real-token", ASTRA_DB_API_ENDPOINT: "http://bad.test" }), /HTTPS/);
});

test("dry-run inspection creates no collection or document", async () => {
  const { db, calls } = mockDb();
  assert.equal((await initializeMovieCollection(db)).state, "missing");
  assert.equal(calls.creates, 0);
  assert.equal(calls.replaces, 0);
});

test("collection mismatch blocks writes and separate OpenAI namespace remains untouched", async () => {
  for (const vectorSettings of [{ dimension: 1536, metric: "cosine" },
    { dimension: 384, metric: "euclidean" },
    { dimension: 384, metric: "cosine", service: { provider: "openai" } }]) {
    const { db, calls } = mockDb({ descriptor: { name: LOCAL_COLLECTION, definition: { vector: vectorSettings } } });
    await assert.rejects(initializeMovieCollection(db, { apply: true }), /incompatible/);
    assert.equal(calls.creates, 0);
    assert.equal(calls.replaces, 0);
  }
  const { db, calls } = mockDb({ descriptor: { name: "movies_openai_1536", definition: { vector: { dimension: 1536, metric: "cosine" } } } });
  assert.equal((await initializeMovieCollection(db, { apply: true })).state, "created");
  assert.equal(calls.creates, 1);
});

test("invalid dimensions, nonfinite values, and zero norm are rejected", () => {
  assert.throws(() => makeMovieVectorDocument(movie, { ...embedding, vector: [1] }), /invalid values or dimensions/);
  assert.throws(() => makeMovieVectorDocument(movie, { ...embedding, vector: [NaN, ...new Array(383).fill(0)] }), /invalid values or dimensions/);
  assert.throws(() => makeMovieVectorDocument(movie, { ...embedding, vector: [Infinity, ...new Array(383).fill(0)] }), /invalid values or dimensions/);
  assert.throws(() => makeMovieVectorDocument(movie, { ...embedding, vector: new Array(384).fill(0) }), /unit L2 norm/);
});

test("stable IDs upsert once, unchanged content skips, changed content replaces", async () => {
  const { collection, documents, calls } = mockDb();
  const original = makeMovieVectorDocument(movie, embedding);
  assert.equal(await upsertMovieVector(collection, original), "inserted");
  assert.equal(await upsertMovieVector(collection, original), "unchanged");
  const metadataOnly = makeMovieVectorDocument({ ...movie, source_url: "https://en.wikipedia.org/wiki/Example_film_2" }, embedding);
  assert.equal(await upsertMovieVector(collection, metadataOnly), "metadata-updated");
  assert.equal(calls.updates, 1);
  assert.equal(calls.replaces, 1);
  const changedMovie = { ...movie, plot: "A changed source plot about a real film." };
  assert.throws(() => makeMovieVectorDocument(changedMovie, embedding), /incompatible with current content/);
  const changed = makeMovieVectorDocument(changedMovie, embeddingFor(changedMovie));
  assert.equal(await upsertMovieVector(collection, changed), "updated");
  assert.equal(documents.size, 1);
  assert.equal(calls.replaces, 2);
  assert.equal(await verifyMovieVector(collection, changed), true);
  assert.deepEqual((await searchMovieVectors(collection, movie.id)).map((item) => item.id), [movie.id]);
});

test("a successful write with failed read-back is reported separately", async () => {
  const { collection } = mockDb();
  collection.countDocuments = async () => 0;
  const [result] = await ingestMovieBatch(collection, [movie], async () => embedding);
  assert.equal(result.status, "failed");
  assert.equal(result.stage, "verify");
  assert.equal(result.writeStatus, "inserted");
  assert.equal(result.readBack, "fail");
});

test("batch reports per-record partial write failures and continues", async () => {
  const second = { ...movie, id: "movie_abcdef0123456789abcd" };
  const { collection, calls, documents } = mockDb({ failId: second.id });
  const results = await ingestMovieBatch(collection, [movie, second], async (item) =>
    embeddingFor(item));
  assert.deepEqual(results.map((item) => item.status), ["inserted", "failed"]);
  assert.equal(calls.replaces, 2);
  assert.equal(documents.size, 1);
  await assert.rejects(ingestMovieBatch(collection, new Array(6).fill(movie), async () => embedding), /one to five unique/);
});
