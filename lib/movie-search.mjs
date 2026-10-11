import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "./astra-runtime.mjs";
import { createEmbeddingProvider, LocalInputTooLongError, LOCAL_DIMENSIONS, LOCAL_MODEL_ID,
  LOCAL_MODEL_REVISION, validateEmbeddingVectors } from "./embedding-provider.mjs";
import { inspectV2Collection, V2_COLLECTION } from "./vector-schema.mjs";

export const MAX_SEARCH_QUERY_LENGTH = 500;
export const MAX_SEARCH_RESULTS = 20;
const RESULT_PROJECTION = Object.freeze({ _id: 1, title: 1, year: 1,
  genre: 1, content_type: 1, source_url: 1 });
const ALLOWED_FILTERS = new Set(["content_type", "genre", "year"]);
let localProvider;

export class MovieSearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MovieSearchError";
    this.code = code;
  }
}

function normalizedText(value) {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function normalizeSearchRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !["query", "topK", "filters"].includes(key))) {
    throw new MovieSearchError("INVALID_REQUEST", "Provide query, optional topK, and supported filters.");
  }
  if (typeof input.query !== "string") {
    throw new MovieSearchError("INVALID_QUERY", "Query must be nonempty text.");
  }
  const query = normalizedText(input.query);
  if (!query || Array.from(query).length > MAX_SEARCH_QUERY_LENGTH ||
      /[\p{Cc}\p{Cf}]/u.test(query)) {
    throw new MovieSearchError("INVALID_QUERY", `Query must contain 1-${MAX_SEARCH_QUERY_LENGTH} visible characters.`);
  }
  const topK = input.topK === undefined ? 10 : input.topK;
  if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_SEARCH_RESULTS) {
    throw new MovieSearchError("INVALID_TOP_K", `topK must be an integer from 1 to ${MAX_SEARCH_RESULTS}.`);
  }
  const filters = input.filters === undefined ? {} : input.filters;
  if (!filters || typeof filters !== "object" || Array.isArray(filters) ||
      Object.keys(filters).some((key) => !ALLOWED_FILTERS.has(key))) {
    throw new MovieSearchError("INVALID_FILTER", "Only content_type, genre, and year filters are supported.");
  }
  if (filters.content_type !== undefined && filters.content_type !== "movie") {
    throw new MovieSearchError("INVALID_FILTER", "content_type must be movie.");
  }
  let genre;
  if (filters.genre !== undefined) {
    if (typeof filters.genre !== "string") {
      throw new MovieSearchError("INVALID_FILTER", "genre must be an exact stored genre string.");
    }
    genre = normalizedText(filters.genre);
    if (!genre || Array.from(genre).length > 160 || /[\p{Cc}\p{Cf}]/u.test(genre)) {
      throw new MovieSearchError("INVALID_FILTER", "genre must be a nonempty exact stored genre string of at most 160 characters.");
    }
  }
  if (filters.year !== undefined &&
      (!Number.isSafeInteger(filters.year) || filters.year < 1800 || filters.year > 2100)) {
    throw new MovieSearchError("INVALID_FILTER", "year must be a release year from 1800 to 2100.");
  }
  return { query, topK, filter: { content_type: "movie", embedding_provider: "local",
    ...(genre === undefined ? {} : { genre }),
    ...(filters.year === undefined ? {} : { year: filters.year }) } };
}

function getLocalProvider() {
  if (!localProvider) {
    // Search never downloads model files at request time.
    env.allowRemoteModels = false;
    localProvider = createEmbeddingProvider({ providerId: "local" });
  }
  return localProvider;
}

function validateQueryVector(embedding, provider) {
  if (provider?.id !== "local" || provider.modelId !== LOCAL_MODEL_ID ||
      provider.modelRevision !== LOCAL_MODEL_REVISION || provider.dimensions !== LOCAL_DIMENSIONS ||
      embedding?.providerId !== "local" || embedding.modelId !== LOCAL_MODEL_ID ||
      embedding.dimensions !== LOCAL_DIMENSIONS) {
    throw new Error("Query embedding provenance is incompatible with v2.");
  }
  validateEmbeddingVectors([embedding.embedding], 1, LOCAL_DIMENSIONS);
  const norm = Math.hypot(...embedding.embedding);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error("Query embedding must have unit L2 norm.");
  }
  return embedding.embedding;
}

function safeMovieResult(row) {
  if (typeof row?._id !== "string" || !/^movie_[a-f0-9]{20,64}$/u.test(row._id) ||
      typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 ||
      /[\p{Cc}\p{Cf}]/u.test(row.title) ||
      row.content_type !== "movie" ||
      !(row.year === null || (Number.isSafeInteger(row.year) && row.year >= 1800 && row.year <= 2100)) ||
      typeof row.genre !== "string" || row.genre.length > 500 ||
      /[\p{Cc}\p{Cf}]/u.test(row.genre) ||
      typeof row.source_url !== "string" || row.source_url.length > 2048) {
    throw new MovieSearchError("INVALID_RESULT", "Astra returned incomplete or invalid movie metadata.");
  }
  let url;
  try { url = new URL(row.source_url); } catch {
    throw new MovieSearchError("INVALID_RESULT", "Astra returned an invalid source URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password ||
      !/(^|\.)wikipedia\.org$/u.test(url.hostname)) {
    throw new MovieSearchError("INVALID_RESULT", "Astra returned an invalid source URL.");
  }
  return { id: row._id, title: row.title, year: row.year,
    genres: row.genre ? row.genre.split(",").map((value) => value.trim()).filter(Boolean) : [],
    contentType: "movie", sourceUrl: row.source_url,
    similarityScore: row.$similarity };
}

/** Read-only service. Dependency injection permits offline tests without DB or model access. */
export function createMovieSearchService({ db, provider, clock = () => performance.now() } = {}) {
  return async function searchMovies(input) {
    const { query, topK, filter } = normalizeSearchRequest(input);
    const started = clock();
    let selectedProvider;
    let vector;
    try {
      selectedProvider = provider ?? getLocalProvider();
      vector = validateQueryVector(await selectedProvider.embedText(query), selectedProvider);
    } catch (error) {
      if (error instanceof LocalInputTooLongError) {
        throw new MovieSearchError("INVALID_QUERY", "Query exceeds the pinned model's 256-token input limit.");
      }
      throw new MovieSearchError("EMBEDDING_UNAVAILABLE",
        "Local query embedding failed. Check the pinned model and local model cache.");
    }
    const embeddingMs = Math.max(0, clock() - started);
    const retrievalStart = clock();
    let rows;
    try {
      const selectedDb = db ?? getAstraDbRuntime();
      const state = await inspectV2Collection(selectedDb);
      if (state.state !== "compatible") {
        throw new MovieSearchError("COLLECTION_MISSING", `${V2_COLLECTION} is unavailable.`);
      }
      rows = await state.collection.find(filter, {
        sort: { $vector: vector }, limit: topK, includeSimilarity: true,
        projection: RESULT_PROJECTION,
      }).toArray();
    } catch (error) {
      if (error instanceof MovieSearchError) throw error;
      if (error?.message === "Existing v2 collection has an incompatible vector or indexing configuration.") {
        throw new MovieSearchError("SCHEMA_MISMATCH", "The v2 vector collection configuration changed.");
      }
      if (/^ASTRA_DB_/u.test(error?.message ?? "") ||
          error?.message === "Could not initialize the Astra DB client. Check the Astra DB configuration.") {
        throw new MovieSearchError("CONFIGURATION_MISSING",
          "Configure server-side ASTRA_DB_API_ENDPOINT and ASTRA_DB_APPLICATION_TOKEN.");
      }
      throw new MovieSearchError("DATABASE_UNAVAILABLE", safeAstraError(error));
    }
    const retrievalMs = Math.max(0, clock() - retrievalStart);
    if (!Array.isArray(rows) || rows.length > topK) {
      throw new MovieSearchError("INVALID_RESULT", "Astra returned an invalid search result set.");
    }
    const results = rows.filter((row) => typeof row?.$similarity === "number" &&
      Number.isFinite(row.$similarity) && row.$similarity >= 0 && row.$similarity <= 1)
      .map(safeMovieResult).sort((a, b) => b.similarityScore - a.similarityScore ||
        a.id.localeCompare(b.id, "en"));
    return { collection: V2_COLLECTION, results,
      timings: { embeddingMs, retrievalMs, totalMs: Math.max(0, clock() - started) } };
  };
}

export const searchMovies = createMovieSearchService();
