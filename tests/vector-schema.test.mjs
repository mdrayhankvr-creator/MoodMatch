import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeCacheIdentity } from "../lib/embedding-cache.mjs";
import { DEFAULT_CHUNK_CONFIG } from "../lib/chunking.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION, V2_DOCUMENT_BYTE_CEILING,
  V2_INDEXED_FIELDS, assessV2MovieDataset, estimateV2MovieDocument,
  inspectV2Collection, makeV2MovieDocument, resolveLocalVectorCollection,
  v2IdFilter, v2MetadataFilter, validateV2CollectionDescriptor,
  validateV2MovieDocument } from "../lib/vector-schema.mjs";

const movie = Object.freeze({ id: "movie_0123456789abcdef0123", title: "A film", year: "2024",
  genre: "", plot: "A complete source plot with é and 🌙 preserved.",
  source_url: "https://en.wikipedia.org/wiki/Example_film" });
const vector = Object.freeze([1, ...new Array(LOCAL_DIMENSIONS - 1).fill(0)]);

function embeddingFor(record) {
  const provenance = makeCacheIdentity({ recordId: record.id,
    normalizedText: buildMovieEmbeddingInput(record), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  const chunks = [{ index: 0, coreStart: 0, coreEnd: record.plot.length,
    spanStart: 0, inputTokens: 20, weight: record.plot.length }];
  const payload = { identity: provenance, chunkCount: 1, chunks, vector };
  return { id: record.id, vector, sourceHash: provenance.sourceHash,
    provenance, chunkCount: 1, chunks,
    cacheIntegrityHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

function descriptor(definition = V2_COLLECTION_DEFINITION) {
  return { name: V2_COLLECTION, definition };
}

test("v2 SDK definition explicitly retains vector search and only selected metadata indexes", () => {
  assert.deepEqual(V2_COLLECTION_DEFINITION.vector, { dimension: 384, metric: "cosine" });
  assert.equal("service" in V2_COLLECTION_DEFINITION.vector, false);
  assert.deepEqual(V2_COLLECTION_DEFINITION.indexing, { allow: V2_INDEXED_FIELDS });
  assert.ok(V2_INDEXED_FIELDS.includes("$vector"));
  assert.ok(V2_INDEXED_FIELDS.includes("content_type"));
  for (const field of ["plot", "source_url", "content_hash", "model_revision", "embedding_version"])
    assert.ok(!V2_INDEXED_FIELDS.includes(field));
  assert.ok(validateV2CollectionDescriptor(descriptor({ ...V2_COLLECTION_DEFINITION,
    vector: { ...V2_COLLECTION_DEFINITION.vector, sourceModel: "other" } })));
  assert.ok(validateV2CollectionDescriptor(descriptor({ ...V2_COLLECTION_DEFINITION,
    lexical: { enabled: true, analyzer: "standard" },
    rerank: { enabled: true, service: { provider: "nvidia",
      modelName: "nvidia/llama-3.2-nv-rerankqa-1b-v2" } } })));
});

test("mismatched v2 descriptors and legacy collection use fail closed", () => {
  const base = V2_COLLECTION_DEFINITION;
  for (const changed of [
    { ...base, vector: { dimension: 1536, metric: "cosine" } },
    { ...base, vector: { dimension: 384, metric: "euclidean" } },
    { ...base, vector: { ...base.vector, service: { provider: "openai" } } },
    { ...base, vector: { ...base.vector, sourceModel: "openai-v3-small" } },
    { ...base, indexing: { allow: ["title", "plot"] } },
    { ...base, indexing: { deny: ["plot"] } },
    { ...base, indexing: { allow: [...V2_INDEXED_FIELDS, "plot"] } },
    { ...base, lexical: { enabled: true, analyzer: "custom" } },
    { ...base, rerank: { enabled: true, service: { provider: "other" } } },
  ]) assert.throws(() => validateV2CollectionDescriptor(descriptor(changed)), /incompatible/);
  assert.throws(() => validateV2CollectionDescriptor({ name: LOCAL_COLLECTION,
    definition: base }), /incompatible/);
  assert.equal(resolveLocalVectorCollection(), LOCAL_COLLECTION);
  assert.equal(resolveLocalVectorCollection(V2_COLLECTION), V2_COLLECTION);
  assert.throws(() => resolveLocalVectorCollection("movies_openai_1536"), /forbidden/);
});

test("v2 inspection cannot create a collection; stable ID and indexed filters support readback", async () => {
  let creates = 0;
  const document = makeV2MovieDocument(movie, embeddingFor(movie));
  const collection = { async findOne(filter) { return filter._id === document._id ? document : null; },
    find(filter) { return { async toArray() {
      return filter.content_type === "movie" ? [document] : [];
    } }; } };
  const db = { async listCollections() { return [descriptor()]; },
    collection(name) { assert.equal(name, V2_COLLECTION); return collection; },
    async createCollection() { creates += 1; throw new Error("must not be called"); } };
  const inspected = await inspectV2Collection(db);
  assert.equal(inspected.state, "compatible");
  assert.equal((await inspected.collection.findOne(v2IdFilter(movie.id)))._id, movie.id);
  assert.equal((await inspected.collection.find(v2MetadataFilter("content_type", "movie")).toArray()).length, 1);
  assert.equal(creates, 0);
  assert.deepEqual(await inspectV2Collection({ ...db, async listCollections() { return []; } }),
    { state: "missing", collection: null });
  assert.throws(() => v2MetadataFilter("plot", "hello"), /not indexed/);
  assert.throws(() => v2MetadataFilter("year", "2024"), /Invalid/);
  assert.throws(() => v2IdFilter("not-a-movie"), /Invalid/);
});

test("v2 document preserves full Unicode plot, source URL and empty genre with local provenance", () => {
  const document = makeV2MovieDocument(movie, embeddingFor(movie));
  assert.equal(document.plot, movie.plot);
  assert.equal(document.source_url, movie.source_url);
  assert.equal(document.genre, "");
  assert.equal(document._id, movie.id);
  assert.equal(document.$vector.length, 384);
  assert.equal(validateV2MovieDocument(document, movie).plotBytes,
    Buffer.byteLength(movie.plot, "utf8"));
  assert.throws(() => validateV2MovieDocument({ ...document, plot: "truncated" }, movie), /plot differs/);
  assert.throws(() => validateV2MovieDocument({ ...document, embedding_provider: "openai" }, movie), /embedding_provider differs/);
  assert.throws(() => validateV2MovieDocument({ ...document, $vector: new Array(384).fill(0) }, movie), /unit L2 norm/);
});

test("indexed strings use UTF-8 bytes while non-indexed plots may exceed 8,000 bytes", () => {
  const longPlot = { ...movie, plot: "é ".repeat(4_001) };
  const document = makeV2MovieDocument(longPlot, embeddingFor(longPlot));
  assert.equal(document.plot, longPlot.plot);
  assert.equal(Buffer.byteLength(document.plot, "utf8"), 12_003);
  const largeTitle = { ...movie, title: "é".repeat(4_001) };
  assert.throws(() => makeV2MovieDocument(largeTitle, embeddingFor(largeTitle)),
    /indexed field title exceeds 8,000 UTF-8 bytes/);
  const assessed = assessV2MovieDataset([longPlot], 1);
  assert.equal(assessed.oversizedLegacyPlots, 1);
  assert.equal(assessed.representable, 1);
  assert.equal(assessed.violations.length, 0);
});

test("conservative byte ceiling validates actual and projected complete documents", () => {
  const hugeMovie = { ...movie, plot: "🌙".repeat(1_000_000) };
  assert.ok(Buffer.byteLength(hugeMovie.plot, "utf8") >= V2_DOCUMENT_BYTE_CEILING);
  assert.throws(() => estimateV2MovieDocument(hugeMovie), /byte limit/);
  assert.throws(() => makeV2MovieDocument(hugeMovie, embeddingFor(hugeMovie)), /byte or documented character limit/);
  assert.ok(estimateV2MovieDocument(movie).estimatedDocumentBytes < V2_DOCUMENT_BYTE_CEILING);
});
