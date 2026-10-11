import test from "node:test";
import assert from "node:assert/strict";
import {
  createSearchController, formatSearchRequest, parseSearchResponse,
  publicMovie, safeSourceUrl, SearchUiError,
} from "../lib/search-ui.mjs";

const movie = {
  id: `movie_${"a".repeat(20)}`, title: "A Real Film", year: 2013,
  genres: ["drama"], contentType: "movie",
  sourceUrl: "https://en.wikipedia.org/wiki/A_Real_Film", similarityScore: 0.82,
  plot: "unlicensed plot", $vector: [0.1, 0.2], content_hash: "internal hash",
  embedding_provider: "local",
};

function ok(results = [movie]) {
  return { ok: true, status: 200,
    json: async () => ({ success: true, data: { results, count: results.length } }) };
}

function form(query = "a hopeful family drama") {
  return { query, genre: "", year: "", topK: "5" };
}

test("request formatting uses exact API filters and accepts every supported topK", () => {
  assert.deepEqual(formatSearchRequest({ query: "  A\nquiet   drama  ", genre: "drama",
    year: "2013", topK: "7" }), {
    query: "A quiet drama", topK: 7,
    filters: { content_type: "movie", genre: "drama", year: 2013 },
  });
  assert.equal(formatSearchRequest({ query: "film", topK: "1" }).topK, 1);
  assert.equal(formatSearchRequest({ query: "film", topK: "20" }).topK, 20);
  assert.deepEqual(formatSearchRequest({ query: "film" }).filters, { content_type: "movie" });
});

test("invalid descriptions and filters stop before any request", () => {
  for (const input of [
    { query: " " }, { query: "a".repeat(501) }, { query: "movie", topK: "21" },
    { query: "movie", topK: "1.5" }, { query: "movie", genre: "made-up genre" },
    { query: "movie", year: "201x" }, { query: "movie", year: "1700" },
  ]) {
    assert.throws(() => formatSearchRequest(input), SearchUiError);
  }
  let calls = 0;
  const controller = createSearchController({ fetchImpl: () => { calls += 1; return ok(); } });
  return controller.submit({ query: " " }).then(() => {
    assert.equal(controller.getState().status, "invalid");
    assert.equal(calls, 0);
    controller.dispose();
  });
});

test("public movie projection removes plot, vectors, hashes and provider metadata", () => {
  const safe = publicMovie(movie);
  assert.deepEqual(Object.keys(safe).sort(),
    ["id", "title", "year", "genres", "contentType", "sourceUrl", "similarityScore"].sort());
  assert.doesNotMatch(JSON.stringify(safe), /unlicensed plot|internal hash|embedding_provider|\$vector/u);
  assert.deepEqual(parseSearchResponse({ success: true,
    data: { results: [movie], count: 1 } }, 5), [safe]);
  assert.throws(() => parseSearchResponse({ success: true,
    data: { results: [movie, movie], count: 2 } }, 1), SearchUiError);
});

test("source links accept only credential-free HTTPS Wikipedia URLs", () => {
  assert.equal(safeSourceUrl(movie.sourceUrl), movie.sourceUrl);
  for (const url of ["javascript:alert(1)", "http://en.wikipedia.org/wiki/Film",
    "https://wikipedia.org.evil.test/film", "https://user:secret@wikipedia.org/film"] ) {
    assert.equal(safeSourceUrl(url), null);
    assert.throws(() => publicMovie({ ...movie, sourceUrl: url }), SearchUiError);
  }
});

test("explicit submission moves from idle through loading to success without automatic requests", async () => {
  const states = [];
  const requests = [];
  const controller = createSearchController({
    onState: (state) => states.push(state.status),
    fetchImpl: async (url, init) => { requests.push({ url, init }); return ok(); },
  });
  assert.equal(controller.getState().status, "idle");
  assert.equal(requests.length, 0);
  await controller.submit({ query: "a family drama", genre: "drama", year: "2013", topK: "5" });
  assert.deepEqual(states, ["loading", "success"]);
  assert.equal(requests[0].url, "/api/search");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.cache, "no-store");
  assert.deepEqual(JSON.parse(requests[0].init.body).filters,
    { content_type: "movie", genre: "drama", year: 2013 });
  assert.equal(controller.getState().results.length, 1);
  controller.dispose();
});

test("empty results and server errors have distinct retryable states", async () => {
  const empty = createSearchController({ fetchImpl: async () => ok([]) });
  await empty.submit(form());
  assert.equal(empty.getState().status, "empty");
  empty.dispose();

  let calls = 0;
  const retryable = createSearchController({ fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? { ok: false, status: 503 } : ok();
  } });
  await retryable.submit(form());
  assert.equal(retryable.getState().status, "error");
  assert.match(retryable.getState().error, /busy|unavailable/iu);
  await retryable.retry();
  assert.equal(retryable.getState().status, "success");
  assert.equal(calls, 2);
  retryable.dispose();
});

test("server timeout and unreadable success payload show safe errors", async () => {
  const timeout = createSearchController({ fetchImpl: async () => ({ ok: false, status: 504 }) });
  await timeout.submit(form());
  assert.equal(timeout.getState().status, "error");
  assert.match(timeout.getState().error, /longer than expected/iu);
  timeout.dispose();

  const malformed = createSearchController({ fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ success: true, data: { results: [{ ...movie, sourceUrl: "javascript:bad()" }], count: 1 } }),
  }) });
  await malformed.submit(form());
  assert.equal(malformed.getState().status, "error");
  assert.doesNotMatch(malformed.getState().error, /javascript|unlicensed plot/iu);
  malformed.dispose();
});

test("client deadline aborts its request and shows a timeout", async () => {
  let signal;
  const controller = createSearchController({
    timeoutMs: 8,
    fetchImpl: (_url, init) => { signal = init.signal; return new Promise(() => {}); },
  });
  await controller.submit(form());
  assert.equal(signal.aborted, true);
  assert.equal(controller.getState().status, "error");
  assert.match(controller.getState().error, /longer than expected/iu);
  controller.dispose();
});

test("same in-flight search is deduplicated; a new search aborts and supersedes it", async () => {
  const pending = [];
  const states = [];
  const controller = createSearchController({
    onState: (state) => states.push(`${state.status}:${state.query}`),
    fetchImpl: (_url, init) => new Promise((resolve) => pending.push({ resolve, signal: init.signal })),
  });
  const first = controller.submit(form("first movie"));
  await controller.submit(form("first movie"));
  assert.equal(pending.length, 1);
  const second = controller.submit(form("second movie"));
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(ok());
  await second;
  pending[0].resolve(ok());
  await first;
  assert.equal(controller.getState().query, "second movie");
  assert.deepEqual(states, ["loading:first movie", "loading:second movie", "success:second movie"]);
  controller.dispose();
});

test("unmount disposal aborts work and suppresses late state updates", async () => {
  let resolveRequest;
  let signal;
  const states = [];
  const controller = createSearchController({
    onState: (state) => states.push(state.status),
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
  });
  const pending = controller.submit(form());
  controller.dispose();
  assert.equal(signal.aborted, true);
  resolveRequest(ok());
  await pending;
  assert.deepEqual(states, ["loading"]);
});
