export const SEARCH_EXAMPLES = Object.freeze([
  "A quiet film about finding your way home",
  "A tense mystery with an unexpected ending",
  "A funny, hopeful story about unlikely friends",
]);

// These are exact genre values present in the current movie catalogue.
export const SEARCH_GENRES = Object.freeze([
  "action", "comedy", "crime", "drama", "horror", "mystery",
  "romance", "science fiction", "thriller", "western",
]);

export const CLIENT_SEARCH_TIMEOUT_MS = 28000;
export const INITIAL_SEARCH_STATE = Object.freeze({
  status: "idle", query: "", results: [], elapsedMs: null, error: null,
});

export class SearchUiError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SearchUiError";
    this.code = code;
  }
}

export function formatSearchRequest({ query, genre = "", year = "", topK = "10" }) {
  if (typeof query !== "string") {
    throw new SearchUiError("INVALID_QUERY", "Describe the kind of film you want to watch.");
  }
  const cleanedQuery = query.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!cleanedQuery || Array.from(cleanedQuery).length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(cleanedQuery)) {
    throw new SearchUiError("INVALID_QUERY", "Enter a mood or story in 1–500 visible characters.");
  }
  const countText = String(topK).trim();
  if (!/^(?:[1-9]|1\d|20)$/u.test(countText)) {
    throw new SearchUiError("INVALID_TOP_K", "Choose between 1 and 20 results.");
  }
  if (typeof genre !== "string" || (genre && !SEARCH_GENRES.includes(genre))) {
    throw new SearchUiError("INVALID_GENRE", "Choose a listed genre or any genre.");
  }
  const yearText = String(year).trim();
  if (yearText && (!/^\d{4}$/u.test(yearText) ||
      Number(yearText) < 1800 || Number(yearText) > 2100)) {
    throw new SearchUiError("INVALID_YEAR", "Enter a four-digit year from 1800 to 2100.");
  }
  return {
    query: cleanedQuery,
    topK: Number(countText),
    filters: {
      content_type: "movie",
      ...(genre ? { genre } : {}),
      ...(yearText ? { year: Number(yearText) } : {}),
    },
  };
}

export function safeSourceUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        !/(^|\.)wikipedia\.org$/u.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function publicMovie(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      typeof value.id !== "string" || !/^movie_[a-f0-9]{20,64}$/u.test(value.id) ||
      typeof value.title !== "string" || !value.title.trim() || value.title.length > 300 ||
      /[\p{Cc}\p{Cf}]/u.test(value.title) ||
      !(value.year === null || (Number.isSafeInteger(value.year) && value.year >= 1800 && value.year <= 2100)) ||
      !Array.isArray(value.genres) || value.genres.some((item) => typeof item !== "string" ||
        item.length > 160 || /[\p{Cc}\p{Cf}]/u.test(item)) ||
      value.contentType !== "movie" ||
      typeof value.similarityScore !== "number" || !Number.isFinite(value.similarityScore) ||
      value.similarityScore < 0 || value.similarityScore > 1) {
    throw new SearchUiError("INVALID_RESPONSE", "Search returned results that could not be displayed.");
  }
  const sourceUrl = safeSourceUrl(value.sourceUrl);
  if (!sourceUrl) {
    throw new SearchUiError("INVALID_RESPONSE", "Search returned results that could not be displayed.");
  }
  const { id, title, year, genres, contentType, similarityScore } = value;
  return { id, title, year, genres, contentType, sourceUrl, similarityScore };
}

export function parseSearchResponse(payload, topK) {
  if (payload?.success !== true || !payload.data ||
      !Array.isArray(payload.data.results) || payload.data.results.length > topK ||
      payload.data.count !== payload.data.results.length) {
    throw new SearchUiError("INVALID_RESPONSE", "Search returned results that could not be displayed.");
  }
  return payload.data.results.map(publicMovie);
}

function httpFailure(status) {
  if (status === 408 || status === 504) {
    return new SearchUiError("TIMEOUT", "Search took longer than expected. Please try again.");
  }
  if (status === 429) {
    return new SearchUiError("RATE_LIMITED", "Too many searches right now. Please wait and retry.");
  }
  if (status === 503) {
    return new SearchUiError("UNAVAILABLE", "Search is busy or temporarily unavailable. Please retry shortly.");
  }
  if (status === 400 || status === 413 || status === 415) {
    return new SearchUiError("INVALID_REQUEST", "The search request was rejected. Check your description and filters.");
  }
  return new SearchUiError("SERVER_ERROR", "Search is unavailable right now. Please try again later.");
}

/** Client abort stops waiting for a response; it does not cancel server-side Astra work. */
export function createSearchController({
  fetchImpl = fetch,
  onState = (_state) => { void _state; },
  timeoutMs = CLIENT_SEARCH_TIMEOUT_MS,
  clock = () => performance.now(),
} = {}) {
  let state = INITIAL_SEARCH_STATE;
  let active = null;
  let generation = 0;
  let disposed = false;
  let lastForm = null;

  function publish(next) {
    state = next;
    if (!disposed) onState(next);
  }

  function stopActive() {
    if (active) {
      active.cancel();
      active = null;
    }
  }

  async function submit(form) {
    if (disposed) return;
    let request;
    try {
      request = formatSearchRequest(form);
    } catch (error) {
      generation += 1;
      stopActive();
      publish({ status: "invalid", query: "", results: [], elapsedMs: null,
        error: error instanceof SearchUiError ? error.message : "Check your search details." });
      return;
    }
    const key = JSON.stringify(request);
    if (active?.key === key) return; // No duplicate expensive request from repeated clicks.
    generation += 1;
    const current = generation;
    stopActive();
    lastForm = { ...form };
    const controller = new AbortController();
    let cancel;
    const cancelled = new Promise((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new SearchUiError("SUPERSEDED", "Search was replaced."));
      };
    });
    active = { key, cancel };
    const started = clock();
    publish({ status: "loading", query: request.query, results: [], elapsedMs: null, error: null });
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new SearchUiError("TIMEOUT", "Search took longer than expected. Please try again."));
      }, timeoutMs);
    });
    try {
      const work = (async () => {
        const response = await fetchImpl("/api/search", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request), cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw httpFailure(response.status);
        let payload;
        try { payload = await response.json(); } catch {
          throw new SearchUiError("INVALID_RESPONSE", "Search returned a response that could not be read.");
        }
        return parseSearchResponse(payload, request.topK);
      })();
      const results = await Promise.race([work, cancelled, deadline]);
      if (disposed || current !== generation) return;
      publish({ status: results.length ? "success" : "empty", query: request.query,
        results, elapsedMs: Math.max(0, clock() - started), error: null });
    } catch (error) {
      if (disposed || current !== generation) return;
      const safe = error instanceof SearchUiError ? error :
        new SearchUiError("NETWORK_ERROR", "Could not connect to search. Check your connection and retry.");
      publish({ status: "error", query: request.query, results: [],
        elapsedMs: Math.max(0, clock() - started), error: safe.message });
    } finally {
      clearTimeout(timer);
      if (active?.key === key && current === generation) active = null;
    }
  }

  return {
    submit,
    retry: () => lastForm && submit(lastForm),
    getState: () => state,
    dispose: () => { disposed = true; generation += 1; stopActive(); },
  };
}
