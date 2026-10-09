import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { DEFAULT_CHUNK_CONFIG } from "./chunking.mjs";
import { DEFAULT_CACHE_ROOT, cacheFilePath, makeCacheIdentity } from "./embedding-cache.mjs";
import { buildMovieEmbeddingInput } from "./embedding-runtime.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./embedding-provider.mjs";
import { inspectMovieCache } from "./movie-embeddings.mjs";
import { deterministicMovieOrder } from "./batch-ingestion.mjs";
import { sourceArticleKey, validPlot, validYear } from "../scripts/movie-data.mjs";
import { EMBEDDING_VERSION, LOCAL_COLLECTION, makeMovieVectorDocument,
  validateCollectionDescriptor, validateMovieRecord, verifyMovieVector,
  ReadBackMismatchError } from "./movie-vector-store.mjs";

export const EXPECTED_DATASET_SIZE = 1100;
export const FULL_CHECKPOINT_VERSION = 1;
export const FULL_EXECUTION_ENABLED = false;
const MAX_PLANNED_BATCH_SIZE = 10;
const MAX_PLANNED_CONCURRENCY = 2;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertFullExecutionDisabled() {
  throw new Error("Full-dataset execution is disabled in Milestone 6C; explicit future approval and a separate implementation are required.");
}

export function parsePreflightArgs(args) {
  if (args.length === 0) return { remoteReadOnly: false };
  if (args.length === 1 && args[0] === "--remote-read-only") return { remoteReadOnly: true };
  if (args.some((flag) => ["--full-run", "--apply", "--execute"].includes(flag))) {
    assertFullExecutionDisabled();
  }
  throw new Error("Use no options or --remote-read-only. Full execution is disabled.");
}

export function validateFullDataset(movies, expectedCount = EXPECTED_DATASET_SIZE) {
  if (!Array.isArray(movies) || movies.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} unified movie records.`);
  }
  const ids = new Set();
  const sources = new Set();
  let missingGenre = 0;
  let missingYear = 0;
  for (const movie of movies) {
    validateMovieRecord(movie);
    if (!validYear(movie.year) || !validPlot(movie.plot)) {
      throw new Error(`Incomplete or invalid movie metadata: ${movie.id}.`);
    }
    if (!movie.genre.trim()) missingGenre += 1;
    if (movie.year === "") missingYear += 1;
    const source = sourceArticleKey(movie.source_url);
    if (!source || ids.has(movie.id) || sources.has(source)) {
      throw new Error(`Duplicate ID, duplicate source identity, or invalid source: ${movie.id}.`);
    }
    ids.add(movie.id);
    sources.add(source);
  }
  return { records: movies.length, uniqueIds: ids.size, uniqueSources: sources.size,
    missingGenre, missingYear };
}

export function planFullBatches(ids, { batchSize = 10, concurrency = 1 } = {}) {
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_PLANNED_BATCH_SIZE ||
      !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > MAX_PLANNED_CONCURRENCY) {
    throw new Error("Planning requires unique IDs, batch size 1..10, and concurrency 1..2.");
  }
  const batches = [];
  for (let start = 0; start < ids.length; start += batchSize) {
    batches.push({ index: batches.length, ids: ids.slice(start, start + batchSize) });
  }
  return { batchSize, concurrency, batches };
}

export function fullConfigurationFingerprint({ batchSize = 10, concurrency = 1 } = {}) {
  planFullBatches(["configuration"], { batchSize, concurrency });
  return sha256(JSON.stringify({ checkpointVersion: FULL_CHECKPOINT_VERSION,
    collection: LOCAL_COLLECTION, provider: "local", model: LOCAL_MODEL_ID,
    revision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
    embeddingVersion: EMBEDDING_VERSION, order: "m6-sample-then-sha256-id-v1",
    batchSize, concurrency, retryAttempts: 3, execution: "disabled" }));
}

function expectedIdentity(movie) {
  return makeCacheIdentity({ recordId: movie.id,
    normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
}

async function hasStaleCache(identity, cacheRoot) {
  const current = cacheFilePath(cacheRoot, identity);
  let entries;
  try { entries = await readdir(dirname(current)); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  return entries.some((name) => name.endsWith(".json") && name !== basename(current));
}

export async function buildFullReadinessPlan({ movies, priorityMovies, provider,
  datasetHash, cacheRoot = DEFAULT_CACHE_ROOT, batchSize = 10, concurrency = 1,
  expectedCount = EXPECTED_DATASET_SIZE, inspectCache = inspectMovieCache,
  detectStale = hasStaleCache }) {
  const dataset = validateFullDataset(movies, expectedCount);
  if (!/^[a-f0-9]{64}$/u.test(datasetHash ?? "") || provider?.id !== "local" ||
      provider.modelId !== LOCAL_MODEL_ID || provider.modelRevision !== LOCAL_MODEL_REVISION ||
      provider.dimensions !== LOCAL_DIMENSIONS) {
    throw new Error("Dataset fingerprint or pinned local embedding provider is incompatible.");
  }
  const ordered = deterministicMovieOrder(movies, priorityMovies);
  const scheduling = planFullBatches(ordered.map((movie) => movie.id), { batchSize, concurrency });
  const records = [];
  const expectedDocuments = new Map();
  for (const movie of ordered) {
    const inspected = await inspectCache(movie, provider, { cacheRoot });
    const identity = expectedIdentity(movie);
    if (JSON.stringify(inspected.identity) !== JSON.stringify(identity) ||
        inspected.plan.fullText !== buildMovieEmbeddingInput(movie) ||
        !Number.isSafeInteger(inspected.plan.chunks.length) || inspected.plan.chunks.length < 1) {
      throw new Error(`Incompatible chunk plan or provenance for ${movie.id}.`);
    }
    let cache = inspected.cached.status;
    if (cache === "hit") {
      const entry = inspected.cached.entry;
      expectedDocuments.set(movie.id, makeMovieVectorDocument(movie, {
        id: movie.id, sourceHash: identity.sourceHash, vector: entry.vector,
        chunkCount: entry.chunkCount, chunks: entry.chunks, provenance: identity,
        cacheIntegrityHash: entry.integrityHash,
      }));
      cache = "reusable";
    } else if (cache === "miss") {
      cache = await detectStale(identity, cacheRoot) ? "stale" : "missing";
    } else if (cache !== "invalid") {
      throw new Error(`Unknown cache status for ${movie.id}.`);
    }
    records.push({ id: movie.id, sourceHash: identity.sourceHash,
      chunks: inspected.plan.chunks.length, cache });
  }
  const coverage = { reusable: 0, missing: 0, stale: 0, invalid: 0,
    totalChunks: 0, inferenceRecords: 0, inferenceChunks: 0 };
  for (const record of records) {
    coverage[record.cache] += 1;
    coverage.totalChunks += record.chunks;
    if (record.cache !== "reusable") {
      coverage.inferenceRecords += 1;
      coverage.inferenceChunks += record.chunks;
    }
  }
  return { dataset, datasetHash, configHash: fullConfigurationFingerprint(scheduling),
    collection: LOCAL_COLLECTION, dimensions: LOCAL_DIMENSIONS, metric: "cosine",
    model: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION,
    embeddingVersion: EMBEDDING_VERSION, coverage, scheduling, records,
    expectedDocuments };
}

export function createFullCheckpointPreview(plan) {
  return { schemaVersion: FULL_CHECKPOINT_VERSION, datasetHash: plan.datasetHash,
    configHash: plan.configHash, selectedIds: plan.records.map((item) => item.id),
    records: {}, completedBatches: [],
    progress: { planned: plan.records.length, verified: 0, failed: 0, uncertain: 0 },
    recoverableFailureIds: [] };
}

export function previewFullResume(plan, checkpoint) {
  if (!checkpoint || checkpoint.schemaVersion !== FULL_CHECKPOINT_VERSION ||
      checkpoint.datasetHash !== plan.datasetHash || checkpoint.configHash !== plan.configHash ||
      JSON.stringify(checkpoint.selectedIds) !== JSON.stringify(plan.records.map((item) => item.id)) ||
      !checkpoint.records || typeof checkpoint.records !== "object" || Array.isArray(checkpoint.records) ||
      !Array.isArray(checkpoint.completedBatches) ||
      !Array.isArray(checkpoint.recoverableFailureIds) ||
      checkpoint.progress?.planned !== plan.records.length) {
    throw new Error("Incompatible full-ingestion checkpoint preview; restart planning after reviewing changes.");
  }
  const pending = [];
  const remoteReconciliationRequired = [];
  const allowed = new Set(["planned", "verified", "write-uncertain", "failed"]);
  for (const record of plan.records) {
    const status = checkpoint.records[record.id]?.status ?? "planned";
    if (!allowed.has(status)) throw new Error("Invalid full-ingestion checkpoint status.");
    if (status === "verified" || status === "write-uncertain") {
      remoteReconciliationRequired.push(record.id);
    } else pending.push(record.id);
  }
  if (Object.keys(checkpoint.records).some((id) => !checkpoint.selectedIds.includes(id))) {
    throw new Error("Full-ingestion checkpoint includes an unknown record.");
  }
  return { pending, remoteReconciliationRequired, safeToSkipWithoutRemoteRead: 0 };
}

/** Pure in-memory rehearsal. It has no database client, model, cache writer, or filesystem access. */
export function simulateFullIngestionMock(plan, scenario = {}) {
  const selected = new Set(plan.records.map((item) => item.id));
  const sets = Object.fromEntries(["existingIds", "rateLimitedIds", "persistentRateLimitIds",
    "uncertainIds", "permanentFailureIds"].map((name) => [name, new Set(scenario[name] ?? [])]));
  if (Object.values(sets).some((items) => [...items].some((id) => !selected.has(id)))) {
    throw new Error("Mock scenario contains an unknown movie ID.");
  }
  const resume = scenario.checkpoint
    ? previewFullResume(plan, scenario.checkpoint)
    : { pending: [...selected], remoteReconciliationRequired: [], safeToSkipWithoutRemoteRead: 0 };
  const reconciliation = new Set(resume.remoteReconciliationRequired);
  const records = [];
  const completedBatches = [];
  const counters = { inserted: 0, unchanged: 0, reconciled: 0, failed: 0,
    simulatedWriteAttempts: 0, simulatedReadbacks: 0, rateLimitRetries: 0 };
  for (const batch of plan.scheduling.batches) {
    let complete = true;
    for (const id of batch.ids) {
      let status;
      let attempts = 0;
      if (sets.existingIds.has(id)) {
        status = "unchanged";
      } else if (sets.permanentFailureIds.has(id)) {
        status = "failed";
        attempts = 1;
      } else if (sets.persistentRateLimitIds.has(id)) {
        status = "failed";
        attempts = 3;
        counters.rateLimitRetries += 2;
      } else if (sets.uncertainIds.has(id)) {
        status = "reconciled";
        attempts = 1;
      } else {
        status = "inserted";
        attempts = sets.rateLimitedIds.has(id) ? 2 : 1;
        if (attempts === 2) counters.rateLimitRetries += 1;
      }
      counters[status] += 1;
      counters.simulatedWriteAttempts += attempts;
      if (status !== "failed") counters.simulatedReadbacks += 1;
      else complete = false;
      records.push({ id, status, attempts,
        resumeReconciliationRequired: reconciliation.has(id) });
    }
    if (complete) completedBatches.push(batch.index);
  }
  return { mode: "mock-only", databaseWrites: 0, inferenceCalls: 0,
    processed: records.length, completedBatches, counters,
    recoverableFailureIds: records.filter((item) => item.status === "failed").map((item) => item.id),
    records };
}

export async function inspectRemoteReadOnly(db, plan) {
  const descriptor = (await db.listCollections()).find((item) => item.name === LOCAL_COLLECTION);
  validateCollectionDescriptor(descriptor);
  const collection = db.collection(LOCAL_COLLECTION);
  const count = await collection.countDocuments({}, 10000);
  if (count >= 10000) throw new Error("Remote count reached the preflight safety bound.");
  const documents = await collection.find({}, { limit: 10000 }).toArray();
  if (documents.length !== count || new Set(documents.map((item) => item._id)).size !== count) {
    throw new Error("Remote inventory is incomplete or contains duplicate IDs.");
  }
  const known = new Set(plan.records.map((item) => item.id));
  const present = new Set(documents.filter((item) => known.has(item._id)).map((item) => item._id));
  const mismatched = [];
  const unverifiable = [];
  let verified = 0;
  for (const id of present) {
    const expected = plan.expectedDocuments.get(id);
    if (!expected) { unverifiable.push(id); continue; }
    try { await verifyMovieVector(collection, expected); verified += 1; }
    catch (error) {
      if (!(error instanceof ReadBackMismatchError)) throw error;
      mismatched.push(id);
    }
  }
  return { collection: LOCAL_COLLECTION, dimensions: descriptor.definition.vector.dimension,
    metric: descriptor.definition.vector.metric, totalRemoteRecords: count,
    existingDatasetRecords: present.size, verified, mismatched, unverifiable,
    unrelatedRemoteRecords: count - present.size,
    missingDatasetRecords: plan.records.length - present.size,
    potentialWritesAfterApproval: plan.records.length - verified };
}
