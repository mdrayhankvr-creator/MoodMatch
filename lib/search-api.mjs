import { MovieSearchError, normalizeSearchRequest, searchMovies } from "./movie-search.mjs";

export const MAX_SEARCH_BODY_BYTES = 8192;
export const MAX_SEARCH_BODY_READ_MS = 5000;
export const SEARCH_TIMEOUT_MS = 20000;
export const MAX_CONCURRENT_SEARCHES = 4;

const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
});

class SearchHttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function jsonResponse(status, data, error, extraHeaders = {}) {
  return Response.json({ success: status === 200, data, error }, {
    status, headers: { ...NO_STORE_HEADERS, ...extraHeaders },
  });
}

function publicError(error) {
  if (error instanceof SearchHttpError) return error;
  if (error instanceof MovieSearchError) {
    if (["INVALID_REQUEST", "INVALID_QUERY", "INVALID_TOP_K", "INVALID_FILTER"].includes(error.code)) {
      return new SearchHttpError(400, error.code, error.message);
    }
    if (error.code === "DATABASE_UNAVAILABLE" &&
        /authentication|authorization|not found|HTTP (?:400|401|403|404|422)/iu.test(error.message)) {
      return new SearchHttpError(500, "SEARCH_CONFIGURATION_ERROR", "Search is not configured correctly.");
    }
    if (["EMBEDDING_UNAVAILABLE", "DATABASE_UNAVAILABLE"].includes(error.code)) {
      return new SearchHttpError(503, error.code, error.message);
    }
    if (["CONFIGURATION_MISSING", "SCHEMA_MISMATCH", "COLLECTION_MISSING"].includes(error.code)) {
      return new SearchHttpError(500, "SEARCH_CONFIGURATION_ERROR", "Search is not configured correctly.");
    }
  }
  return new SearchHttpError(500, "SEARCH_FAILED", "Search failed unexpectedly.");
}

async function readBoundedJson(request, bodyTimeoutMs) {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)) {
    throw new SearchHttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json.");
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    const length = Number(rawLength);
    if (!/^\d+$/u.test(rawLength) || !Number.isSafeInteger(length)) {
      throw new SearchHttpError(400, "INVALID_CONTENT_LENGTH", "Content-Length is invalid.");
    }
    if (length > MAX_SEARCH_BODY_BYTES) {
      throw new SearchHttpError(413, "REQUEST_TOO_LARGE", "JSON request body exceeds 8 KiB.");
    }
  }
  if (!request.body) throw new SearchHttpError(400, "INVALID_JSON", "Request body must be a JSON object.");
  const reader = request.body.getReader();
  const bytes = new Uint8Array(MAX_SEARCH_BODY_BYTES);
  let count = 0;
  let bodyTimer;
  const deadline = new Promise((_, reject) => {
    bodyTimer = setTimeout(() => {
      reject(new SearchHttpError(408, "REQUEST_BODY_TIMEOUT", "JSON request body took too long to arrive."));
      void reader.cancel().catch(() => {});
    }, bodyTimeoutMs);
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      if (!(value instanceof Uint8Array) || count + value.byteLength > MAX_SEARCH_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new SearchHttpError(413, "REQUEST_TOO_LARGE", "JSON request body exceeds 8 KiB.");
      }
      bytes.set(value, count);
      count += value.byteLength;
    }
  } catch (error) {
    if (error instanceof SearchHttpError) throw error;
    throw new SearchHttpError(400, "INVALID_BODY", "Could not read the JSON request body.");
  } finally {
    clearTimeout(bodyTimer);
    reader.releaseLock();
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)));
  } catch {
    throw new SearchHttpError(400, "INVALID_JSON", "Request body must contain valid UTF-8 JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SearchHttpError(400, "INVALID_JSON", "Request body must be a JSON object.");
  }
  return parsed;
}

function publicResults(response, topK) {
  if (!Array.isArray(response?.results) || response.results.length > topK) {
    throw new SearchHttpError(500, "INVALID_SEARCH_RESULT", "Search returned an invalid result set.");
  }
  return response.results.map((item) => {
    if (!item || typeof item.id !== "string" || typeof item.title !== "string" ||
        !(item.year === null || Number.isSafeInteger(item.year)) ||
        !Array.isArray(item.genres) || item.genres.some((genre) => typeof genre !== "string") ||
        item.contentType !== "movie" || typeof item.sourceUrl !== "string" ||
        typeof item.similarityScore !== "number" || !Number.isFinite(item.similarityScore)) {
      throw new SearchHttpError(500, "INVALID_SEARCH_RESULT", "Search returned an invalid result set.");
    }
    const { id, title, year, genres, contentType, sourceUrl, similarityScore } = item;
    return { id, title, year, genres, contentType, sourceUrl, similarityScore };
  });
}

function safeDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 10) / 10 : 0;
}

/** Per-process concurrency is a resource bound, not a distributed rate limit. */
export function createSearchPostHandler(search = searchMovies, {
  maxConcurrent = MAX_CONCURRENT_SEARCHES, timeoutMs = SEARCH_TIMEOUT_MS,
  bodyTimeoutMs = MAX_SEARCH_BODY_READ_MS,
  clock = () => performance.now(),
} = {}) {
  let active = 0;
  return async function POST(request) {
    const started = clock();
    try {
      const body = await readBoundedJson(request, bodyTimeoutMs);
      const normalized = normalizeSearchRequest(body);
      if (active >= maxConcurrent) {
        throw new SearchHttpError(503, "SEARCH_BUSY", "Search is busy. Retry shortly.");
      }
      active += 1;
      const work = Promise.resolve().then(() => search(body));
      // Keep the capacity slot until the underlying model/DB work settles,
      // even if the HTTP response reaches its own deadline first.
      void work.then(() => { active -= 1; }, () => { active -= 1; });
      let timer;
      try {
        const response = await Promise.race([work, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new SearchHttpError(504, "SEARCH_TIMEOUT",
            "Search exceeded its server-side response deadline.")), timeoutMs);
        })]);
        const results = publicResults(response, normalized.topK);
        const timings = response?.timings ?? {};
        return jsonResponse(200, { results, count: results.length, query: normalized.query }, null, {
          "Server-Timing": `embed;dur=${safeDuration(timings.embeddingMs)}, db;dur=${safeDuration(timings.retrievalMs)}, total;dur=${safeDuration(clock() - started)}`,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      const safe = publicError(error);
      return jsonResponse(safe.status, null, { code: safe.code, message: safe.message }, {
        ...(safe.code === "SEARCH_BUSY" ? { "Retry-After": "1" } : {}),
        "Server-Timing": `total;dur=${safeDuration(clock() - started)}`,
      });
    }
  };
}
