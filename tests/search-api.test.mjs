import test from "node:test";
import assert from "node:assert/strict";
import { createSearchPostHandler, MAX_SEARCH_BODY_BYTES } from "../lib/search-api.mjs";
import { MovieSearchError } from "../lib/movie-search.mjs";

const result = { id: `movie_${"a".repeat(20)}`, title: "A Movie", year: 2019,
  genres: ["drama"], contentType: "movie",
  sourceUrl: "https://en.wikipedia.org/wiki/A_Movie", similarityScore: 0.82,
  plot: "private plot", $vector: [1, 0], content_hash: "private hash" };

function request(body, contentType = "application/json") {
  return new Request("http://localhost/api/search", { method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body) });
}

function service(results = [result]) {
  return async () => ({ results, timings: { embeddingMs: 12.25, retrievalMs: 91.57 } });
}

test("valid POST returns only approved public fields and no-store timing headers", async () => {
  let passed;
  const post = createSearchPostHandler(async (input) => {
    passed = input;
    return service()();
  });
  const response = await post(request({ query: "  A\n mystery  ", topK: 5,
    filters: { content_type: "movie", genre: "drama", year: 2019 } }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.match(response.headers.get("server-timing"), /embed;dur=12\.3, db;dur=91\.6/);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.error, null);
  assert.equal(body.data.query, "A mystery");
  assert.equal(body.data.count, 1);
  assert.deepEqual(Object.keys(body.data.results[0]).sort(),
    ["id", "title", "year", "genres", "contentType", "sourceUrl", "similarityScore"].sort());
  assert.ok(!JSON.stringify(body).includes("private plot"));
  assert.ok(!JSON.stringify(body).includes("private hash"));
  assert.deepEqual(passed.filters, { content_type: "movie", genre: "drama", year: 2019 });
});

test("empty result sets keep the success contract", async () => {
  const response = await createSearchPostHandler(service([]))(request({ query: "unmatched" }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { results: [], count: 0, query: "unmatched" });
});

test("malformed, non-object, empty, and unknown-field requests return 400 before search", async () => {
  let calls = 0;
  const post = createSearchPostHandler(async () => { calls += 1; return service()(); });
  for (const body of ["{", "[]", "null", "", { query: "" },
    { query: "   " }, { query: 42 }, { query: "test", surprise: true }]) {
    const response = await post(request(body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
    assert.match(response.headers.get("cache-control"), /no-store/);
  }
  assert.equal(calls, 0);
});

test("invalid topK and unsupported filters return 400 before search", async () => {
  const post = createSearchPostHandler(() => { throw new Error("must not search"); });
  for (const body of [{ query: "test", topK: 0 }, { query: "test", topK: 21 },
    { query: "test", filters: { plot: "secret" } },
    { query: "test", filters: { content_type: "series" } },
    { query: "test", filters: { year: "2019" } }]) {
    const response = await post(request(body));
    assert.equal(response.status, 400);
  }
});

test("unsupported content types return 415", async () => {
  const post = createSearchPostHandler(() => { throw new Error("must not search"); });
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "application/json-patch+json"]) {
    const response = await post(request({ query: "test" }, type));
    assert.equal(response.status, 415);
    assert.equal((await response.json()).error.code, "UNSUPPORTED_MEDIA_TYPE");
  }
  assert.equal((await post(new Request("http://localhost/api/search", { method: "POST" }))).status, 415);
});

test("oversized declared and streamed bodies return 413 without calling search", async () => {
  let calls = 0;
  const post = createSearchPostHandler(async () => { calls += 1; return service()(); });
  const declared = new Request("http://localhost/api/search", { method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": String(MAX_SEARCH_BODY_BYTES + 1) },
    body: "{}" });
  assert.equal((await post(declared)).status, 413);
  assert.equal((await post(request("x".repeat(MAX_SEARCH_BODY_BYTES + 1)))).status, 413);
  assert.equal(calls, 0);
});

test("temporary outages return 503; persistent failures and malformed results return safe 500", async () => {
  for (const code of ["EMBEDDING_UNAVAILABLE", "DATABASE_UNAVAILABLE"]) {
    const post = createSearchPostHandler(async () => { throw new MovieSearchError(code, "Service unavailable."); });
    assert.equal((await post(request({ query: "test" }))).status, 503);
  }
  for (const error of [
    new MovieSearchError("COLLECTION_MISSING", "Missing collection."),
    new MovieSearchError("SCHEMA_MISMATCH", "Incompatible descriptor."),
    new MovieSearchError("DATABASE_UNAVAILABLE", "Astra DB authentication or authorization failed."),
  ]) {
    const post = createSearchPostHandler(async () => { throw error; });
    const response = await post(request({ query: "test" }));
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error.code, "SEARCH_CONFIGURATION_ERROR");
  }
  const invalid = createSearchPostHandler(service([{ ...result, similarityScore: NaN }]));
  assert.equal((await invalid(request({ query: "test" }))).status, 500);
  const unknown = createSearchPostHandler(async () => { throw new Error("Authorization: secret-token"); });
  const response = await unknown(request({ query: "test" }));
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /secret-token|Authorization/);
});

test("a stalled request body returns 408 without starting a search", async () => {
  const body = new ReadableStream({ start() {} });
  const request = new Request("http://localhost/api/search", { method: "POST",
    headers: { "Content-Type": "application/json" }, body, duplex: "half" });
  const post = createSearchPostHandler(() => { throw new Error("must not search"); },
    { bodyTimeoutMs: 5 });
  const response = await post(request);
  assert.equal(response.status, 408);
  assert.equal((await response.json()).error.code, "REQUEST_BODY_TIMEOUT");
});

test("response deadline returns 504 while retaining the active capacity slot", async () => {
  let complete;
  const pending = new Promise((resolve) => { complete = resolve; });
  const post = createSearchPostHandler(() => pending, { maxConcurrent: 1, timeoutMs: 5 });
  const timedOut = await post(request({ query: "test" }));
  assert.equal(timedOut.status, 504);
  const busy = await post(request({ query: "test" }));
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "1");
  complete(await service()());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await post(request({ query: "test" }))).status, 200);
});
