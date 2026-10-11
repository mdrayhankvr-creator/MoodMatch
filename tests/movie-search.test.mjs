import test from "node:test";
import assert from "node:assert/strict";
import { createMovieSearchService, MovieSearchError, normalizeSearchRequest,
  MAX_SEARCH_QUERY_LENGTH } from "../lib/movie-search.mjs";
import { LocalInputTooLongError, LOCAL_DIMENSIONS, LOCAL_MODEL_ID,
  LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { V2_COLLECTION, V2_INDEXED_FIELDS } from "../lib/vector-schema.mjs";

const vector = [1, ...Array(LOCAL_DIMENSIONS - 1).fill(0)];
const idA = `movie_${"a".repeat(20)}`;
const idB = `movie_${"b".repeat(20)}`;
const baseRow = { _id: idA, title: "Movie A", year: 2019, genre: "drama, mystery",
  content_type: "movie", source_url: "https://en.wikipedia.org/wiki/Movie_A", $similarity: 0.8 };
const descriptor = { name: V2_COLLECTION, definition: {
  vector: { dimension: LOCAL_DIMENSIONS, metric: "cosine" },
  indexing: { allow: V2_INDEXED_FIELDS },
} };
const provider = { id: "local", modelId: LOCAL_MODEL_ID,
  modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
  async embedText() { return { embedding: vector, providerId: "local",
    modelId: LOCAL_MODEL_ID, dimensions: LOCAL_DIMENSIONS }; } };

function mockService(rows = [baseRow], overrides = {}) {
  const calls = [];
  const collection = { find(filter, options) {
    calls.push({ filter, options });
    return { async toArray() { return rows; } };
  }, insertOne() { throw new Error("write attempted"); },
  updateOne() { throw new Error("write attempted"); },
  deleteOne() { throw new Error("write attempted"); } };
  const db = { async listCollections() { return [descriptor]; },
    collection(name) { calls.push({ collection: name }); return collection; },
    createCollection() { throw new Error("write attempted"); } };
  return { search: createMovieSearchService({ db, provider, ...overrides }), calls };
}

test("query normalization, boundaries, topK, and unsupported inputs", () => {
  const request = normalizeSearchRequest({ query: "  A\tfilm\nabout   family  ", filters: { genre: " drama " } });
  assert.equal(request.query, "A film about family");
  assert.deepEqual(request.filter, { content_type: "movie", embedding_provider: "local", genre: "drama" });
  assert.equal(request.topK, 10);
  assert.equal(normalizeSearchRequest({ query: "x".repeat(MAX_SEARCH_QUERY_LENGTH) }).query.length,
    MAX_SEARCH_QUERY_LENGTH);
  for (const query of ["", " \n ", 12, "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1), "a\u0000b"]) {
    assert.throws(() => normalizeSearchRequest({ query }), MovieSearchError);
  }
  for (const topK of [0, 21, 1.5, "5"]) {
    assert.throws(() => normalizeSearchRequest({ query: "hello", topK }), /topK/);
  }
  for (const filters of [{ plot: "secret" }, { content_type: "series" },
    { genre: ["drama"] }, { year: "2019" }, { year: 2101 }]) {
    assert.throws(() => normalizeSearchRequest({ query: "hello", filters }), MovieSearchError);
  }
});

test("only the v2 collection receives bounded server-side vector search and indexed filters", async () => {
  const { search, calls } = mockService();
  const response = await search({ query: "friendship", topK: 3,
    filters: { content_type: "movie", genre: "drama, mystery", year: 2019 } });
  assert.equal(response.collection, V2_COLLECTION);
  assert.deepEqual(calls[0], { collection: V2_COLLECTION });
  assert.deepEqual(calls[1].filter, { content_type: "movie", embedding_provider: "local",
    genre: "drama, mystery", year: 2019 });
  assert.deepEqual(calls[1].options.sort, { $vector: vector });
  assert.equal(calls[1].options.limit, 3);
  assert.equal(calls[1].options.includeSimilarity, true);
  assert.ok(!Object.hasOwn(calls[1].options.projection, "plot"));
  assert.ok(!Object.hasOwn(calls[1].options.projection, "$vector"));
  assert.deepEqual(response.results[0], { id: idA, title: "Movie A", year: 2019,
    genres: ["drama", "mystery"], contentType: "movie",
    sourceUrl: "https://en.wikipedia.org/wiki/Movie_A", similarityScore: 0.8 });
  assert.ok(Number.isFinite(response.timings.embeddingMs));
  assert.ok(Number.isFinite(response.timings.retrievalMs));
});

test("normalized text is passed to the pinned local embedding provider", async () => {
  let embeddedText;
  const local = { ...provider, async embedText(text) {
    embeddedText = text;
    return provider.embedText(text);
  } };
  const { search } = mockService([], { provider: local });
  await search({ query: "  mystery\n and   adventure  " });
  assert.equal(embeddedText, "mystery and adventure");
});

test("scores sort high to low with stable ID ties and invalid scores excluded", async () => {
  const { search } = mockService([{ ...baseRow, _id: idB }, baseRow,
    { ...baseRow, _id: `movie_${"c".repeat(20)}`, $similarity: NaN },
    { ...baseRow, _id: `movie_${"d".repeat(20)}`, $similarity: 0.9 }]);
  const result = await search({ query: "mystery", topK: 4 });
  assert.deepEqual(result.results.map((item) => item.id),
    [`movie_${"d".repeat(20)}`, idA, idB]);
});

test("empty genre and unknown year remain missing metadata", async () => {
  const { search } = mockService([{ ...baseRow, genre: "", year: null }]);
  const result = await search({ query: "mystery" });
  assert.deepEqual(result.results[0].genres, []);
  assert.equal(result.results[0].year, null);
  assert.equal(Object.keys(result.results[0]).length, 7);
});

test("invalid embeddings and model failures stop before any database read", async () => {
  for (const broken of [
    { ...provider, async embedText() { return { embedding: [1, 0], providerId: "local",
      modelId: LOCAL_MODEL_ID, dimensions: LOCAL_DIMENSIONS }; } },
    { ...provider, async embedText() { return { embedding: Array(LOCAL_DIMENSIONS).fill(0.5),
      providerId: "local", modelId: LOCAL_MODEL_ID, dimensions: LOCAL_DIMENSIONS }; } },
    { ...provider, async embedText() { return { embedding: [NaN, ...vector.slice(1)],
      providerId: "local", modelId: LOCAL_MODEL_ID, dimensions: LOCAL_DIMENSIONS }; } },
    { ...provider, modelRevision: "wrong" },
    { ...provider, async embedText() { throw new Error("private model path"); } },
  ]) {
    const { search, calls } = mockService([], { provider: broken });
    await assert.rejects(search({ query: "test" }), (error) => {
      assert.equal(error.code, "EMBEDDING_UNAVAILABLE");
      assert.doesNotMatch(error.message, /private model path/);
      return true;
    });
    assert.equal(calls.length, 0);
  }
});

test("model token limit produces an input error without a database read", async () => {
  const limited = { ...provider, async embedText() { throw new LocalInputTooLongError(0, 300); } };
  const { search, calls } = mockService([], { provider: limited });
  await assert.rejects(search({ query: "many tokens" }), (error) => error.code === "INVALID_QUERY");
  assert.equal(calls.length, 0);
});

test("missing or incompatible v2 descriptor and Astra errors are sanitized", async () => {
  for (const [listCollections, code] of [
    [async () => [], "COLLECTION_MISSING"],
    [async () => [{ ...descriptor, definition: { ...descriptor.definition,
      vector: { dimension: 1536, metric: "cosine" } } }], "SCHEMA_MISMATCH"],
    [async () => { throw new Error("Authorization: secret-token"); }, "DATABASE_UNAVAILABLE"],
  ]) {
    const search = createMovieSearchService({ provider,
      db: { listCollections, collection() { throw new Error("must not be called"); } } });
    await assert.rejects(search({ query: "test" }), (error) => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    });
  }
});

test("unsafe attribution URLs or missing required movie metadata are rejected", async () => {
  for (const row of [{ ...baseRow, source_url: "https://evil.example/movie" },
    { ...baseRow, source_url: "https://user:secret@en.wikipedia.org/wiki/Movie_A" },
    { ...baseRow, title: "" }, { ...baseRow, title: "bad\u0000title" }]) {
    const { search } = mockService([row]);
    await assert.rejects(search({ query: "test" }), (error) => error.code === "INVALID_RESULT");
  }
});

test("Astra query failures expose no SDK message or credentials", async () => {
  const db = { async listCollections() { return [descriptor]; },
    collection() { return { find() { throw new Error("Authorization: secret-token"); } }; } };
  const search = createMovieSearchService({ db, provider });
  await assert.rejects(search({ query: "test" }), (error) => {
    assert.equal(error.code, "DATABASE_UNAVAILABLE");
    assert.doesNotMatch(error.message, /secret-token|Authorization/);
    assert.equal(error.cause, undefined);
    return true;
  });
});
