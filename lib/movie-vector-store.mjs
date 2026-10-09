import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION, validateEmbeddingVectors } from "./embedding-provider.mjs";
import { DEFAULT_CHUNK_CONFIG } from "./chunking.mjs";
import { AGGREGATION_VERSION } from "./embedding-cache.mjs";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { createHash } from "node:crypto";
import { buildMovieEmbeddingInput } from "./embedding-runtime.mjs";
import { makeCacheIdentity } from "./embedding-cache.mjs";

export const LOCAL_COLLECTION = "movies_local_384";
export const EMBEDDING_VERSION = `${AGGREGATION_VERSION}:max${DEFAULT_CHUNK_CONFIG.maxTokens}:content${DEFAULT_CHUNK_CONFIG.contentTokens}:overlap${DEFAULT_CHUNK_CONFIG.overlapTokens}`;

export class CollectionConfigurationError extends Error {
  constructor() {
    super("Existing local movie collection has incompatible vector dimensions, metric, or vectorization service.");
    this.name = "CollectionConfigurationError";
  }
}

export class ReadBackMismatchError extends Error {
  constructor(id) {
    super(`Read-back verification failed for ${id}.`);
    this.name = "ReadBackMismatchError";
  }
}

export function validateCollectionDescriptor(descriptor) {
  if (descriptor?.name !== LOCAL_COLLECTION ||
      descriptor.definition?.vector?.dimension !== LOCAL_DIMENSIONS ||
      descriptor.definition.vector.metric !== "cosine" ||
      descriptor.definition.vector.service != null) {
    throw new CollectionConfigurationError();
  }
}

export async function initializeMovieCollection(db, { apply = false } = {}) {
  const existing = (await db.listCollections()).find((item) => item.name === LOCAL_COLLECTION);
  if (existing) {
    validateCollectionDescriptor(existing);
    return { collection: db.collection(LOCAL_COLLECTION), state: "reused" };
  }
  if (!apply) return { collection: null, state: "missing" };
  const collection = await db.createCollection(LOCAL_COLLECTION, {
    vector: { dimension: LOCAL_DIMENSIONS, metric: "cosine" },
  });
  const created = (await db.listCollections()).find((item) => item.name === LOCAL_COLLECTION);
  validateCollectionDescriptor(created);
  return { collection, state: "created" };
}

export function validateMovieRecord(movie) {
  if (!movie || typeof movie.id !== "string" || !/^movie_[a-f0-9]{20,64}$/u.test(movie.id) ||
      typeof movie.title !== "string" || !movie.title.trim() ||
      typeof movie.plot !== "string" || !movie.plot.trim() ||
      typeof movie.genre !== "string" ||
      typeof movie.source_url !== "string") {
    throw new Error("Movie metadata is missing or invalid.");
  }
  let url;
  try { url = new URL(movie.source_url); } catch { throw new Error("Movie source URL is invalid."); }
  if (url.protocol !== "https:" || !/(^|\.)wikipedia\.org$/u.test(url.hostname)) {
    throw new Error("Movie source URL is invalid.");
  }
  if (movie.year !== "" && !/^(18|19|20)\d{2}$/u.test(String(movie.year))) {
    throw new Error("Movie release year is invalid.");
  }
}

export function makeMovieVectorDocument(movie, embedding) {
  validateMovieRecord(movie);
  const expectedProvenance = makeCacheIdentity({
    recordId: movie.id, normalizedText: buildMovieEmbeddingInput(movie),
    providerId: "local", modelId: LOCAL_MODEL_ID,
    modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
    chunkConfig: DEFAULT_CHUNK_CONFIG,
  });
  if (embedding?.id !== movie.id || !/^[a-f0-9]{64}$/u.test(embedding.sourceHash ?? "") ||
      embedding.sourceHash !== expectedProvenance.sourceHash ||
      JSON.stringify(embedding.provenance) !== JSON.stringify(expectedProvenance) ||
      !Number.isSafeInteger(embedding.chunkCount) || embedding.chunkCount < 1 ||
      !Array.isArray(embedding.chunks) || embedding.chunks.length !== embedding.chunkCount) {
    throw new Error("Movie embedding provenance or chunk metadata is incompatible with current content.");
  }
  validateEmbeddingVectors([embedding.vector], 1, LOCAL_DIMENSIONS);
  const norm = Math.hypot(...embedding.vector);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error("Movie embedding must have a unit L2 norm.");
  }
  const payload = { identity: embedding.provenance, chunkCount: embedding.chunkCount,
    chunks: embedding.chunks, vector: embedding.vector };
  const integrityHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  if (embedding.cacheIntegrityHash !== integrityHash) {
    throw new Error("Movie embedding cache integrity does not match the supplied vector.");
  }
  return {
    _id: movie.id, content_type: "movie", title: movie.title,
    year: movie.year === "" ? null : Number(movie.year), genre: movie.genre,
    plot: movie.plot, source_url: movie.source_url, content_hash: embedding.sourceHash,
    embedding_provider: "local", embedding_model: LOCAL_MODEL_ID,
    model_revision: LOCAL_MODEL_REVISION, embedding_version: EMBEDDING_VERSION,
    chunk_count: embedding.chunkCount, $vector: embedding.vector,
  };
}

const METADATA_KEYS = ["content_type", "title", "year", "genre", "plot", "source_url", "content_hash",
  "embedding_provider", "embedding_model", "model_revision", "embedding_version", "chunk_count"];

function sameMetadata(a, b) {
  return METADATA_KEYS.every((key) => a?.[key] === b[key]);
}

const EMBEDDING_KEYS = ["content_hash", "embedding_provider", "embedding_model",
  "model_revision", "embedding_version", "chunk_count"];

function sameEmbeddingIdentity(a, b) {
  return EMBEDDING_KEYS.every((key) => a?.[key] === b[key]);
}

function validStoredVector(vector) {
  try {
    const values = vector instanceof DataAPIVector ? vector.asArray() : vector;
    validateEmbeddingVectors([values], 1, LOCAL_DIMENSIONS);
    const norm = Math.hypot(...values);
    return Number.isFinite(norm) && Math.abs(norm - 1) <= 1e-4;
  } catch { return false; }
}

function sameStoredVector(stored, expected) {
  if (!validStoredVector(stored) || !validStoredVector(expected)) return false;
  const values = stored instanceof DataAPIVector ? stored.asArray() : stored;
  return values.every((value, index) => Math.abs(value - expected[index]) <= 1e-5);
}

export async function upsertMovieVector(collection, document) {
  if (!document || document.embedding_provider !== "local" ||
      document.embedding_model !== LOCAL_MODEL_ID ||
      document.model_revision !== LOCAL_MODEL_REVISION ||
      document.embedding_version !== EMBEDDING_VERSION ||
      !validStoredVector(document.$vector)) {
    throw new Error("Invalid local movie vector document.");
  }
  const existing = await collection.findOne({ _id: document._id }, { projection: { $vector: 1,
    ...Object.fromEntries(METADATA_KEYS.map((key) => [key, 1])) } });
  if (existing && sameMetadata(existing, document) && sameStoredVector(existing.$vector, document.$vector)) {
    return "unchanged";
  }
  if (existing && sameEmbeddingIdentity(existing, document) && sameStoredVector(existing.$vector, document.$vector)) {
    const metadata = Object.fromEntries(METADATA_KEYS.map((key) => [key, document[key]]));
    await collection.updateOne({ _id: document._id }, { $set: metadata });
    return "metadata-updated";
  }
  const { _id, ...replacement } = document;
  await collection.replaceOne({ _id }, replacement, { upsert: true });
  return existing ? "updated" : "inserted";
}

export async function verifyMovieVector(collection, expected) {
  const stored = await collection.findOne({ _id: expected._id }, { projection: { _id: 1, $vector: 1,
    ...Object.fromEntries(METADATA_KEYS.map((key) => [key, 1])) } });
  if (!stored || stored._id !== expected._id || !sameMetadata(stored, expected) ||
      !sameStoredVector(stored.$vector, expected.$vector)) {
    throw new ReadBackMismatchError(expected._id);
  }
  const count = await collection.countDocuments({ _id: expected._id }, 2);
  if (count !== 1) throw new ReadBackMismatchError(expected._id);
  return true;
}

export async function ingestMovieBatch(collection, movies, prepareEmbedding) {
  if (!Array.isArray(movies) || movies.length < 1 || movies.length > 5 ||
      new Set(movies.map((movie) => movie.id)).size !== movies.length) {
    throw new Error("Controlled ingestion requires one to five unique movie IDs.");
  }
  const results = [];
  for (const movie of movies) {
    let stage = "prepare";
    let writeStatus;
    try {
      const embedding = await prepareEmbedding(movie);
      const document = makeMovieVectorDocument(movie, embedding);
      stage = "upsert";
      writeStatus = await upsertMovieVector(collection, document);
      stage = "verify";
      await verifyMovieVector(collection, document);
      results.push({ id: movie.id, status: writeStatus, readBack: "pass", cache: embedding.cacheStatus });
    } catch (error) {
      results.push({ id: movie.id, status: "failed", stage, writeStatus,
        readBack: stage === "verify" ? "fail" : "not-run", error });
    }
  }
  return results;
}

export async function searchMovieVectors(collection, sampleId, limit = 5) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new Error("Similarity limit must be 1..5.");
  const sample = await collection.findOne({ _id: sampleId }, { projection: { _id: 1, $vector: 1 } });
  if (!sample || !validStoredVector(sample.$vector)) throw new Error("Stored sample vector is missing or invalid.");
  const matches = await collection.find({}, {
    sort: { $vector: sample.$vector }, limit, includeSimilarity: true,
    projection: { _id: 1, title: 1 },
  }).toArray();
  if (!matches.some((item) => item._id === sampleId) ||
      matches.some((item) => typeof item._id !== "string" || typeof item.title !== "string" ||
        !Number.isFinite(item.$similarity))) {
    throw new Error("Similarity lookup returned invalid results or omitted the sample record.");
  }
  return matches.map(({ _id, title, $similarity }) => ({ id: _id, title, similarity: $similarity }));
}
