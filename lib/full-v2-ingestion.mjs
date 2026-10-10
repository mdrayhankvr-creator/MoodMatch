import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DEFAULT_CHUNK_CONFIG } from "./chunking.mjs";
import { AGGREGATION_VERSION } from "./embedding-cache.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./embedding-provider.mjs";
import { buildFullReadinessPlan, validateFullDataset } from "./full-ingestion-readiness.mjs";
import { writeIngestionCheckpoint } from "./ingestion-checkpoint.mjs";
import { embedMovieLocally, inspectMovieCache } from "./movie-embeddings.mjs";
import { EMBEDDING_VERSION, LOCAL_COLLECTION } from "./movie-vector-store.mjs";
import { APPROVED_LEGACY_SNAPSHOT_HASH, APPROVED_V2_MIGRATION_RECORDS,
  reconcileUncertainV2Write, verifyExactV2Document, verifyV2Descriptor } from "./vector-v2-live-migration.mjs";
import { makeVerifiedMigrationDocument, matchesExpectedDocument,
  planV2Migration } from "./vector-migration-plan.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION, assessV2MovieDataset,
  estimateV2MovieDocument, makeV2MovieDocument, v2IdFilter } from "./vector-schema.mjs";

export const FULL_V2_CHECKPOINT_PATH = resolve("data/cache/ingestion/full-v2-movies.json");
export const FULL_V2_CHECKPOINT_VERSION = 1;
export const FULL_V2_BATCH_SIZE = 10;
const FULL_V2_APPLY_APPROVED = false;
const MAX_MOVIES = 1100;
const READBACK_DELAYS_MS = [100, 250];
const CHECKPOINT_STATUSES = new Set(["matching", "inserted", "reconciled", "failed"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function assertFullV2ApplyApproved() {
  if (!FULL_V2_APPLY_APPROVED) {
    throw new Error("Full v2 ingestion is disabled; its separate hardcoded approval gate is closed.");
  }
}

export function parseFullV2Args(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
    return { mode: "dry-run" };
  }
  if (args.length === 2 && new Set(args).size === 2 &&
      args.includes("--apply") && args.includes("--confirm-full-ingestion")) {
    return { mode: "apply" };
  }
  throw new Error("Use no options, --dry-run, or both --apply and --confirm-full-ingestion.");
}

export function fullV2ConfigurationFingerprint() {
  return sha256(JSON.stringify({ checkpointVersion: FULL_V2_CHECKPOINT_VERSION,
    collection: V2_COLLECTION, collectionDefinition: V2_COLLECTION_DEFINITION,
    provider: "local", model: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG,
    aggregationVersion: AGGREGATION_VERSION, embeddingVersion: EMBEDDING_VERSION,
    order: "sha256-id-v1", batchSize: FULL_V2_BATCH_SIZE,
    writePolicy: "sequential-insert-only-exact-readback-v1" }));
}

function assertExpectedPlan(expected) {
  if (!/^[a-f0-9]{64}$/u.test(expected?.datasetHash ?? "") ||
      !/^[a-f0-9]{64}$/u.test(expected?.configHash ?? "") ||
      !Array.isArray(expected?.orderedIds) || expected.orderedIds.length !== MAX_MOVIES ||
      new Set(expected.orderedIds).size !== MAX_MOVIES ||
      !(expected.sourceHashes instanceof Map) || expected.sourceHashes.size !== MAX_MOVIES ||
      expected.orderedIds.some((id) => !/^[a-z0-9_]+$/u.test(id) ||
        !/^[a-f0-9]{64}$/u.test(expected.sourceHashes.get(id) ?? ""))) {
    throw new Error("Invalid full-v2 checkpoint source or configuration.");
  }
}

export function newFullV2Checkpoint(expected) {
  assertExpectedPlan(expected);
  return { schemaVersion: FULL_V2_CHECKPOINT_VERSION,
    datasetHash: expected.datasetHash, configHash: expected.configHash,
    orderedIds: [...expected.orderedIds], records: {} };
}

export function validateFullV2Checkpoint(state, expected) {
  assertExpectedPlan(expected);
  if (!state || state.schemaVersion !== FULL_V2_CHECKPOINT_VERSION ||
      state.datasetHash !== expected.datasetHash || state.configHash !== expected.configHash ||
      JSON.stringify(state.orderedIds) !== JSON.stringify(expected.orderedIds) ||
      !state.records || typeof state.records !== "object" || Array.isArray(state.records)) {
    throw new Error("Incompatible or corrupt full-v2 checkpoint; review source and schema before resuming.");
  }
  for (const [id, record] of Object.entries(state.records)) {
    if (!expected.sourceHashes.has(id) || !record ||
        !CHECKPOINT_STATUSES.has(record.status) ||
        record.sourceHash !== expected.sourceHashes.get(id)) {
      throw new Error("Corrupt full-v2 checkpoint record or source hash.");
    }
  }
  return state;
}

export async function loadFullV2Checkpoint(path, expected) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { state: newFullV2Checkpoint(expected), resumed: false };
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Corrupt full-v2 checkpoint JSON."); }
  return { state: validateFullV2Checkpoint(parsed, expected), resumed: true };
}

export function reconcileCheckpointWithRemote(state, existingIds) {
  for (const [id, record] of Object.entries(state.records)) {
    if (record.status !== "failed" && !existingIds.has(id)) {
      throw new Error("A previously verified checkpoint record is absent remotely; stop for review.");
    }
  }
  return true;
}

export function recordFullV2Outcome(state, expected, id, status) {
  if (!CHECKPOINT_STATUSES.has(status) || !expected.sourceHashes.has(id)) {
    throw new Error("Invalid full-v2 checkpoint outcome.");
  }
  state.records[id] = { status, sourceHash: expected.sourceHashes.get(id) };
  return state;
}

/** Read-only inventory: every present document needs a current checksum-valid cache entry. */
export async function reconcileFullV2Inventory({ collection, movies, records, provider,
  inspectCache = inspectMovieCache, makeExpectedDocument = makeVerifiedMigrationDocument }) {
  if (records.length !== MAX_MOVIES || new Set(records.map((item) => item.id)).size !== MAX_MOVIES) {
    throw new Error("Full-v2 inventory requires exactly 1,100 unique source records.");
  }
  const sourceHashes = new Map(records.map(({ id, sourceHash }) => [id, sourceHash]));
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const count = await collection.countDocuments({}, MAX_MOVIES + 1);
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_MOVIES) {
    throw new Error("V2 count exceeds or differs from the approved 1,100-movie boundary.");
  }
  const rows = await collection.find({}, { limit: MAX_MOVIES + 1,
    projection: { _id: 1, content_hash: 1 } }).toArray();
  if (rows.length !== count || new Set(rows.map((row) => row._id)).size !== count ||
      rows.some((row) => !sourceHashes.has(row._id) ||
        sourceHashes.get(row._id) !== row.content_hash)) {
    throw new Error("V2 contains an unexpected ID, duplicate ID, or source-hash conflict.");
  }
  const existingIds = new Set(rows.map((row) => row._id));
  if (APPROVED_V2_MIGRATION_RECORDS.some((record) => !existingIds.has(record.id) ||
      sourceHashes.get(record.id) !== record.sourceHash)) {
    throw new Error("The ten verified v2 sample documents must remain present and unchanged.");
  }
  for (const id of existingIds) {
    const expected = await makeExpectedDocument(moviesById.get(id), provider, inspectCache);
    await verifyExactV2Document(collection, expected);
  }
  const missingRecords = records.filter((record) => !existingIds.has(record.id));
  const estimatedMissingDocumentBytes = missingRecords.reduce((sum, record) =>
    sum + estimateV2MovieDocument(moviesById.get(record.id)).estimatedDocumentBytes, 0);
  return { existingIds, missingRecords, counts: { matching: count,
    missing: missingRecords.length, conflicts: 0 },
  estimatedMissingDocumentBytes,
  missingCacheHits: missingRecords.filter((item) => item.cache === "reusable").length,
  missingInvalidCaches: missingRecords.filter((item) => item.cache === "invalid").length,
  expectedInferenceRecords: missingRecords.filter((item) => item.cache !== "reusable").length,
  expectedInferenceChunks: missingRecords.filter((item) => item.cache !== "reusable")
    .reduce((sum, item) => sum + item.chunks, 0) };
}

/** Plans all 1,100 records without embedding generation, checkpoint writes, or DB writes. */
export async function planFullV2Ingestion({ db, movies, provider, datasetHash,
  inspectCache = inspectMovieCache }) {
  const dataset = validateFullDataset(movies);
  if (provider?.id !== "local" || provider.modelId !== LOCAL_MODEL_ID ||
      provider.modelRevision !== LOCAL_MODEL_REVISION || provider.dimensions !== LOCAL_DIMENSIONS) {
    throw new Error("Full-v2 ingestion requires the pinned local 384-dimensional provider.");
  }
  const sizeAudit = assessV2MovieDataset(movies);
  if (sizeAudit.violations.length) throw new Error("V2 size or indexed-field audit failed.");
  const readiness = await buildFullReadinessPlan({ movies, priorityMovies: [],
    provider, datasetHash, inspectCache });
  const collection = await verifyV2Descriptor(db);
  const legacy = await planV2Migration({ db, movies, provider, inspectCache });
  if (legacy.legacyCollection !== LOCAL_COLLECTION ||
      legacy.legacySnapshotHash !== APPROVED_LEGACY_SNAPSHOT_HASH ||
      legacy.counts.alreadyMatching !== APPROVED_V2_MIGRATION_RECORDS.length) {
    throw new Error("Legacy snapshot or the ten verified v2 sample records changed.");
  }
  const inventory = await reconcileFullV2Inventory({ collection, movies,
    records: readiness.records, provider, inspectCache });
  const configHash = fullV2ConfigurationFingerprint();
  const expectedCheckpoint = { datasetHash, configHash,
    orderedIds: readiness.records.map((record) => record.id),
    sourceHashes: new Map(readiness.records.map((record) => [record.id, record.sourceHash])) };
  assertExpectedPlan(expectedCheckpoint);
  return { collection, moviesById: new Map(movies.map((movie) => [movie.id, movie])),
    dataset, datasetHash, configHash, sizeAudit, readiness, inventory,
    expectedCheckpoint };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function boundedSuccessfulReadback(collection, expected, sleep) {
  for (let attempt = 0; attempt <= READBACK_DELAYS_MS.length; attempt += 1) {
    try { return await verifyExactV2Document(collection, expected); }
    catch (error) {
      if (error?.reason === "integrity" || attempt === READBACK_DELAYS_MS.length) throw error;
      await sleep(READBACK_DELAYS_MS[attempt]);
    }
  }
}

/** Create-only, one insertion attempt. An uncertain response permits reads, never a second insert. */
export async function insertMissingV2Document(collection, expected,
  { sleep = defaultSleep } = {}) {
  const stored = await collection.findOne(v2IdFilter(expected._id),
    { projection: { _id: 1, $vector: 1, content_type: 1, title: 1, year: 1,
      genre: 1, plot: 1, source_url: 1, content_hash: 1, embedding_provider: 1,
      embedding_model: 1, model_revision: 1, embedding_version: 1, chunk_count: 1 } });
  if (stored) {
    if (!matchesExpectedDocument(stored, expected)) {
      throw new Error("V2 document conflicts with the current source or embedding.");
    }
    await verifyExactV2Document(collection, expected);
    return "matching";
  }
  try { await collection.insertOne(expected); }
  catch (error) {
    await reconcileUncertainV2Write(collection, expected, error, { sleep });
    return "reconciled";
  }
  await boundedSuccessfulReadback(collection, expected, sleep);
  return "inserted";
}

/** Future write path. The public entry point calls the separate closed gate first. */
export async function executeFullV2Ingestion({ db, movies, provider, datasetHash,
  checkpointPath = FULL_V2_CHECKPOINT_PATH, inspectCache = inspectMovieCache,
  embedMovie = embedMovieLocally, sleep = defaultSleep, onProgress = () => {} }) {
  assertFullV2ApplyApproved();
  const plan = await planFullV2Ingestion({ db, movies, provider, datasetHash, inspectCache });
  if (plan.inventory.missingInvalidCaches) {
    throw new Error("Invalid local embedding cache entries require review before ingestion.");
  }
  const { state, resumed } = await loadFullV2Checkpoint(checkpointPath, plan.expectedCheckpoint);
  reconcileCheckpointWithRemote(state, plan.inventory.existingIds);
  for (const id of plan.inventory.existingIds) {
    recordFullV2Outcome(state, plan.expectedCheckpoint, id, "matching");
  }
  await writeIngestionCheckpoint(checkpointPath, state);
  let inserted = 0;
  let reconciled = 0;
  let inferredChunks = 0;
  for (const record of plan.inventory.missingRecords) {
    try {
      const movie = plan.moviesById.get(record.id);
      const embedding = await embedMovie(movie, provider,
        { allowInference: true, rejectInvalidCache: true });
      inferredChunks += embedding.inferenceCalls ?? 0;
      const expected = makeV2MovieDocument(movie, embedding);
      if (expected.content_hash !== record.sourceHash) {
        throw new Error("Source hash changed during full-v2 ingestion.");
      }
      const status = await insertMissingV2Document(plan.collection, expected, { sleep });
      recordFullV2Outcome(state, plan.expectedCheckpoint, record.id, status);
      await writeIngestionCheckpoint(checkpointPath, state);
      if (status === "inserted") inserted += 1;
      if (status === "reconciled") reconciled += 1;
      onProgress({ id: record.id, status });
      await sleep(100);
    } catch (error) {
      recordFullV2Outcome(state, plan.expectedCheckpoint, record.id, "failed");
      await writeIngestionCheckpoint(checkpointPath, state);
      throw error;
    }
  }
  const final = await planFullV2Ingestion({ db, movies, provider, datasetHash, inspectCache });
  if (final.inventory.counts.matching !== MAX_MOVIES || final.inventory.counts.missing !== 0 ||
      final.inventory.counts.conflicts !== 0 ||
      final.datasetHash !== plan.datasetHash || final.configHash !== plan.configHash) {
    throw new Error("Final full-v2 inventory or source configuration is incomplete.");
  }
  return { resumed, matching: final.inventory.counts.matching, inserted, reconciled,
    inferredChunks, checkpointPath };
}

export function summarizeFullV2DryRun(plan, checkpointResumed = false) {
  return { mode: "dry-run", executionEnabled: false, databaseWrites: 0,
    inferenceCalls: 0, collection: V2_COLLECTION, sourceTotal: plan.dataset.records,
    uniqueIds: plan.dataset.uniqueIds, legacyCount: 10,
    legacySnapshotHash: APPROVED_LEGACY_SNAPSHOT_HASH,
    matching: plan.inventory.counts.matching, missing: plan.inventory.counts.missing,
    conflicts: plan.inventory.counts.conflicts,
    provider: "local", model: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, metric: "cosine",
    cacheHitsForMissing: plan.inventory.missingCacheHits,
    invalidCachesForMissing: plan.inventory.missingInvalidCaches,
    expectedInferenceRecords: plan.inventory.expectedInferenceRecords,
    expectedInferenceChunks: plan.inventory.expectedInferenceChunks,
    estimatedMissingDocumentBytesUpperBound: plan.inventory.estimatedMissingDocumentBytes,
    largestProjectedDocumentBytes: plan.sizeAudit.maxEstimatedDocumentBytes,
    sizeViolations: plan.sizeAudit.violations.length,
    oversizedLegacyIndexedPlots: plan.sizeAudit.oversizedLegacyPlots,
    datasetHash: plan.datasetHash, configHash: plan.configHash,
    checkpointResumed, checkpointWrites: 0,
    accountSpecificCapacity: "UNKNOWN", licensing: "article-level redistribution review outstanding" };
}
