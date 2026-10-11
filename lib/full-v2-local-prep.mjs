import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { APPROVED_V2_MIGRATION_RECORDS } from "./vector-v2-live-migration.mjs";
import { APPROVED_FULL_V2_DATASET_HASH,
  fullV2ConfigurationFingerprint } from "./full-v2-ingestion.mjs";
import { buildFullReadinessPlan } from "./full-ingestion-readiness.mjs";
import { writeIngestionCheckpoint } from "./ingestion-checkpoint.mjs";
import { embedMovieLocally } from "./movie-embeddings.mjs";
import { assessV2MovieDataset, makeV2MovieDocument } from "./vector-schema.mjs";

export const LOCAL_PREP_CHECKPOINT_PATH = resolve("data/cache/ingestion/full-v2-local-prep.json");
export { APPROVED_FULL_V2_DATASET_HASH };
const CHECKPOINT_VERSION = 1;
const REMAINING_MOVIES = 1090;

export function localPrepExpected(readiness, datasetHash) {
  if (datasetHash !== APPROVED_FULL_V2_DATASET_HASH ||
      readiness?.datasetHash !== datasetHash || readiness.records?.length !== 1100) {
    throw new Error("The full-v2 local preparation source fingerprint changed.");
  }
  const byId = new Map(readiness.records.map((record) => [record.id, record]));
  for (const approved of APPROVED_V2_MIGRATION_RECORDS) {
    if (byId.get(approved.id)?.sourceHash !== approved.sourceHash) {
      throw new Error("The ten approved sample source hashes changed.");
    }
  }
  const pinned = new Set(APPROVED_V2_MIGRATION_RECORDS.map((record) => record.id));
  const records = readiness.records.filter((record) => !pinned.has(record.id));
  if (records.length !== REMAINING_MOVIES ||
      new Set(records.map((record) => record.id)).size !== REMAINING_MOVIES ||
      records.some((record) => !/^[a-f0-9]{64}$/u.test(record.sourceHash))) {
    throw new Error("Local preparation requires exactly 1,090 distinct missing-source IDs.");
  }
  return { datasetHash, configHash: fullV2ConfigurationFingerprint(),
    orderedIds: records.map((record) => record.id),
    sourceHashes: new Map(records.map((record) => [record.id, record.sourceHash])),
    chunkCounts: new Map(records.map((record) => [record.id, record.chunks])),
    records };
}

export function newLocalPrepCheckpoint(expected) {
  return { schemaVersion: CHECKPOINT_VERSION, datasetHash: expected.datasetHash,
    configHash: expected.configHash, orderedIds: [...expected.orderedIds], records: {} };
}

export function validateLocalPrepCheckpoint(state, expected) {
  if (!state || state.schemaVersion !== CHECKPOINT_VERSION ||
      state.datasetHash !== expected.datasetHash || state.configHash !== expected.configHash ||
      JSON.stringify(state.orderedIds) !== JSON.stringify(expected.orderedIds) ||
      !state.records || typeof state.records !== "object" || Array.isArray(state.records)) {
    throw new Error("Local preparation checkpoint is corrupt or incompatible.");
  }
  for (const [id, record] of Object.entries(state.records)) {
    if (!expected.sourceHashes.has(id) || record?.status !== "cached" ||
        record.sourceHash !== expected.sourceHashes.get(id) ||
        record.chunkCount !== expected.chunkCounts.get(id) ||
        !Number.isSafeInteger(record.inferenceCalls) || record.inferenceCalls < 0 ||
        record.inferenceCalls > record.chunkCount) {
      throw new Error("Local preparation checkpoint record is invalid.");
    }
  }
  return state;
}

export async function loadLocalPrepCheckpoint(path, expected) {
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { state: newLocalPrepCheckpoint(expected), resumed: false };
    throw error;
  }
  let state;
  try { state = JSON.parse(raw); }
  catch { throw new Error("Local preparation checkpoint JSON is corrupt."); }
  return { state: validateLocalPrepCheckpoint(state, expected), resumed: true };
}

/** Local-only preparation. Checkpoints never authorize a remote write or a cache skip. */
export async function prepareFullV2Embeddings({ movies, provider, datasetHash,
  checkpointPath = LOCAL_PREP_CHECKPOINT_PATH, embedMovie = embedMovieLocally,
  onProgress = () => {} }) {
  const sizeAudit = assessV2MovieDataset(movies);
  if (sizeAudit.violations.length) throw new Error("The full-v2 document-size audit failed.");
  const readiness = await buildFullReadinessPlan({ movies, priorityMovies: [],
    provider, datasetHash });
  const expected = localPrepExpected(readiness, datasetHash);
  if (expected.records.some((record) => record.cache === "invalid")) {
    throw new Error("An invalid embedding cache requires review before local preparation.");
  }
  const { state, resumed } = await loadLocalPrepCheckpoint(checkpointPath, expected);
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  let generated = 0;
  let chunksProcessed = 0;
  for (const [index, record] of expected.records.entries()) {
    const movie = moviesById.get(record.id);
    const embedding = await embedMovie(movie, provider,
      { allowInference: true, rejectInvalidCache: true });
    const document = makeV2MovieDocument(movie, embedding);
    if (document._id !== record.id || document.content_hash !== record.sourceHash ||
        embedding.chunkCount !== record.chunks) {
      throw new Error("Local embedding does not match the approved source and chunk plan.");
    }
    if (embedding.inferenceCalls > 0) {
      generated += 1;
      chunksProcessed += embedding.inferenceCalls;
    }
    state.records[record.id] = { status: "cached", sourceHash: record.sourceHash,
      chunkCount: record.chunks,
      inferenceCalls: embedding.inferenceCalls || state.records[record.id]?.inferenceCalls || 0 };
    await writeIngestionCheckpoint(checkpointPath, state);
    if ((index + 1) % 25 === 0 || index + 1 === REMAINING_MOVIES) {
      onProgress({ prepared: index + 1, total: REMAINING_MOVIES,
        generatedThisRun: generated, chunksProcessedThisRun: chunksProcessed });
    }
  }
  const verified = await buildFullReadinessPlan({ movies, priorityMovies: [],
    provider, datasetHash });
  const final = localPrepExpected(verified, datasetHash);
  if (final.records.some((record) => record.cache !== "reusable") ||
      Object.keys(state.records).length !== REMAINING_MOVIES) {
    throw new Error("Local preparation did not leave 1,090 verified cache entries.");
  }
  validateLocalPrepCheckpoint(state, expected);
  return { resumed, prepared: REMAINING_MOVIES, generatedThisRun: generated,
    chunksProcessedThisRun: chunksProcessed,
    cachedTotal: final.records.length, datasetHash, configHash: expected.configHash,
    checkpointPath };
}
