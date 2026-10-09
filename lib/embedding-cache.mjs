import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { validateEmbeddingVectors } from "./embedding-provider.mjs";

export const AGGREGATION_VERSION = "core-codepoints-v1";
export const DEFAULT_CACHE_ROOT = resolve("data/cache/embeddings");
const CACHE_SCHEMA = 1;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeSegment(value, label) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{1,100}$/u.test(value)) {
    throw new Error(`Invalid ${label} for embedding cache path.`);
  }
  return value;
}

export function makeCacheIdentity({ recordId, normalizedText, providerId, modelId, modelRevision,
  dimensions, chunkConfig }) {
  safeSegment(recordId, "record ID");
  safeSegment(providerId, "provider ID");
  if (typeof normalizedText !== "string" || !normalizedText.trim() ||
      typeof modelId !== "string" || !modelId.trim() ||
      typeof modelRevision !== "string" || !modelRevision.trim() ||
      !Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new Error("Invalid embedding cache identity.");
  }
  const sourceHash = sha256(normalizedText);
  const descriptor = {
    schemaVersion: CACHE_SCHEMA, recordId, providerId, modelId, modelRevision, dimensions,
    chunkConfig: { maxTokens: chunkConfig.maxTokens, contentTokens: chunkConfig.contentTokens,
      overlapTokens: chunkConfig.overlapTokens },
    aggregationVersion: AGGREGATION_VERSION, sourceHash,
  };
  if (!Object.values(descriptor.chunkConfig).every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid chunk configuration in cache identity.");
  }
  return { ...descriptor, key: sha256(JSON.stringify(descriptor)) };
}

export function cacheFilePath(root, identity) {
  return join(resolve(root), safeSegment(identity.providerId, "provider ID"),
    safeSegment(identity.recordId, "record ID"), `${identity.key}.json`);
}

function vectorNorm(vector) {
  return Math.hypot(...vector);
}

function isValidEntry(entry, identity, expectedChunks) {
  if (!entry || typeof entry !== "object" || !entry.identity || !Array.isArray(entry.chunks) ||
      JSON.stringify(entry.identity) !== JSON.stringify(identity) ||
      JSON.stringify(entry.chunks) !== JSON.stringify(expectedChunks) ||
      entry.chunkCount !== expectedChunks.length || entry.chunkCount < 1 ||
      typeof entry.integrityHash !== "string") return false;
  try {
    validateEmbeddingVectors([entry.vector], 1, identity.dimensions);
  } catch { return false; }
  const norm = vectorNorm(entry.vector);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) return false;
  const { integrityHash, ...payload } = entry;
  return integrityHash === sha256(JSON.stringify(payload));
}

export async function readCachedEmbedding(root, identity, expectedChunks) {
  let raw;
  try {
    raw = await readFile(cacheFilePath(root, identity), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { status: "miss" };
    throw error;
  }
  try {
    const entry = JSON.parse(raw);
    return isValidEntry(entry, identity, expectedChunks)
      ? { status: "hit", entry }
      : { status: "invalid" };
  } catch { return { status: "invalid" }; }
}

export async function writeCachedEmbedding(root, identity, chunks, vector) {
  validateEmbeddingVectors([vector], 1, identity.dimensions);
  const norm = vectorNorm(vector);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error("Cannot cache an embedding with an invalid L2 norm.");
  }
  const payload = { identity, chunkCount: chunks.length, chunks, vector };
  const entry = { ...payload, integrityHash: sha256(JSON.stringify(payload)) };
  const target = cacheFilePath(root, identity);
  const directory = join(resolve(root), identity.providerId, identity.recordId);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `${identity.key}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(entry), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
