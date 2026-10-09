import { LOCAL_DIMENSIONS, LOCAL_MODEL_REVISION, validateEmbeddingVectors } from "./embedding-provider.mjs";
import { chunkDescription } from "./chunking.mjs";
import {
  DEFAULT_CACHE_ROOT, makeCacheIdentity, readCachedEmbedding, writeCachedEmbedding,
} from "./embedding-cache.mjs";

export function chunkMetadata(plan) {
  return plan.chunks.map(({ index, coreStart, coreEnd, spanStart, inputTokens, weight }) =>
    ({ index, coreStart, coreEnd, spanStart, inputTokens, weight }));
}

export class EmbeddingCacheUnavailableError extends Error {
  constructor(status, reason = "inference was not enabled") {
    super(`Local embedding cache is ${status}; ${reason}.`);
    this.name = "EmbeddingCacheUnavailableError";
    this.status = status;
  }
}

/** Tokenize current content and verify the matching local cache entry without inference. */
export async function inspectDescriptionCache(record, provider, options = {}) {
  if (provider?.id !== "local" || provider.dimensions !== LOCAL_DIMENSIONS ||
      typeof provider.tokenCounts !== "function" || typeof provider.embedText !== "function") {
    throw new Error("Local description embedding requires the 384-dimensional local provider.");
  }
  if (provider.modelRevision !== LOCAL_MODEL_REVISION) {
    throw new Error("Local model revision is missing or unsupported.");
  }
  const plan = await chunkDescription(record, provider.tokenCounts, options.chunkConfig);
  const metadata = chunkMetadata(plan);
  const identity = makeCacheIdentity({
    recordId: record.id, normalizedText: plan.fullText, providerId: provider.id,
    modelId: provider.modelId, modelRevision: provider.modelRevision,
    dimensions: provider.dimensions, chunkConfig: plan.config,
  });
  const root = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
  const cached = await readCachedEmbedding(root, identity, metadata);
  return { plan, metadata, identity, root, cached };
}

export async function inspectMovieCache(movie, provider, options = {}) {
  return inspectDescriptionCache({ id: movie.id, title: movie.title, genre: movie.genre,
    description: movie.plot }, provider, options);
}

export function aggregateChunkVectors(chunks, vectors, dimensions = LOCAL_DIMENSIONS) {
  validateEmbeddingVectors(vectors, chunks.length, dimensions);
  if (chunks.length === 0 || chunks.some((chunk) => !Number.isSafeInteger(chunk.weight) || chunk.weight < 1)) {
    throw new Error("Cannot aggregate chunks with invalid unique-content weights.");
  }
  const sum = new Array(dimensions).fill(0);
  let totalWeight = 0;
  for (const [index, vector] of vectors.entries()) {
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm <= 0) throw new Error(`Chunk ${index} has a zero or invalid vector norm.`);
    const weight = chunks[index].weight;
    totalWeight += weight;
    for (let dimension = 0; dimension < dimensions; dimension += 1) {
      sum[dimension] += weight * vector[dimension] / norm;
    }
  }
  if (!Number.isFinite(totalWeight) || totalWeight <= 0) throw new Error("Invalid aggregate weight.");
  const norm = Math.hypot(...sum);
  if (!Number.isFinite(norm) || norm <= 0) throw new Error("Aggregated embedding has a zero or invalid norm.");
  const result = sum.map((value) => value / norm);
  validateEmbeddingVectors([result], 1, dimensions);
  return result;
}

export async function embedDescriptionLocally(record, provider, options = {}) {
  const { plan, metadata, identity, root, cached } = await inspectDescriptionCache(record, provider, options);
  if (cached.status === "hit") {
    return { id: record.id, vector: cached.entry.vector, sourceHash: identity.sourceHash,
      chunkCount: plan.chunks.length, chunks: metadata, provenance: identity,
      cacheIntegrityHash: cached.entry.integrityHash,
      cacheStatus: "hit", inferenceCalls: 0 };
  }
  if (cached.status === "invalid" && options.rejectInvalidCache) {
    throw new EmbeddingCacheUnavailableError("invalid", "corrupt entries are rejected");
  }
  if (options.allowInference === false) throw new EmbeddingCacheUnavailableError(cached.status);

  const vectors = [];
  for (const chunk of plan.chunks) {
    const result = await provider.embedText(chunk.text);
    if (result.providerId !== provider.id || result.modelId !== provider.modelId ||
        result.dimensions !== provider.dimensions) {
      throw new Error(`Chunk ${chunk.index} came from an incompatible embedding provider.`);
    }
    validateEmbeddingVectors([result.embedding], 1, LOCAL_DIMENSIONS);
    vectors.push(result.embedding);
  }
  const vector = aggregateChunkVectors(plan.chunks, vectors);
  await writeCachedEmbedding(root, identity, metadata, vector);
  const verified = await readCachedEmbedding(root, identity, metadata);
  if (verified.status !== "hit") throw new Error("Generated local embedding failed cache verification.");
  return { id: record.id, vector, sourceHash: identity.sourceHash,
    chunkCount: plan.chunks.length, chunks: metadata, provenance: identity,
    cacheIntegrityHash: verified.entry.integrityHash,
    inferenceCalls: vectors.length,
    cacheStatus: cached.status === "invalid" ? "repaired" : "miss" };
}

export async function embedMovieLocally(movie, provider, options = {}) {
  return embedDescriptionLocally({ id: movie.id, title: movie.title, genre: movie.genre,
    description: movie.plot }, provider, options);
}
