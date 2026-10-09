import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { LOCAL_COLLECTION, EMBEDDING_VERSION } from "./movie-vector-store.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./embedding-provider.mjs";

export const DEFAULT_INGESTION_STATE = resolve("data/cache/ingestion/local-movies-384.json");
const SCHEMA_VERSION = 1;

export async function datasetFingerprint(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function ingestionConfigurationFingerprint() {
  return createHash("sha256").update(JSON.stringify({
    schema: SCHEMA_VERSION, collection: LOCAL_COLLECTION, provider: "local",
    model: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
    embeddingVersion: EMBEDDING_VERSION, order: "m6-sample-then-sha256-id-v1",
  })).digest("hex");
}

export function newIngestionCheckpoint({ datasetHash, configHash, selectedIds, batchSize }) {
  if (![datasetHash, configHash].every((hash) => /^[a-f0-9]{64}$/u.test(hash)) ||
      !Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > 10 ||
      new Set(selectedIds).size !== selectedIds.length ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10) {
    throw new Error("Invalid ingestion checkpoint configuration.");
  }
  return { schemaVersion: SCHEMA_VERSION, datasetHash, configHash,
    selectedIds: [...selectedIds], batchSize, records: {}, completedBatches: [] };
}

function validateCheckpoint(state, expected) {
  if (!state || state.schemaVersion !== SCHEMA_VERSION ||
      state.datasetHash !== expected.datasetHash || state.configHash !== expected.configHash ||
      JSON.stringify(state.selectedIds) !== JSON.stringify(expected.selectedIds) ||
      state.batchSize !== expected.batchSize) {
    throw new Error("Incompatible ingestion checkpoint; start without --resume after reviewing the dataset change.");
  }
  if (!state.records || typeof state.records !== "object" || Array.isArray(state.records) ||
      !Array.isArray(state.completedBatches)) throw new Error("Corrupt ingestion checkpoint.");
  for (const [id, entry] of Object.entries(state.records)) {
    if (!state.selectedIds.includes(id) || !entry ||
        !["inserted", "updated", "metadata-updated", "unchanged", "skipped", "reconciled", "failed"].includes(entry.status) ||
        typeof entry.verified !== "boolean" ||
        (entry.verified && !/^[a-f0-9]{64}$/u.test(entry.sourceHash ?? "")) ||
        (entry.status === "failed" && entry.verified)) {
      throw new Error("Corrupt ingestion checkpoint.");
    }
  }
  const completed = completedBatchIndexes(state);
  if (JSON.stringify(state.completedBatches) !== JSON.stringify(completed)) {
    throw new Error("Corrupt ingestion checkpoint batch completion state.");
  }
  return state;
}

function completedBatchIndexes(state) {
  const indexes = [];
  for (let start = 0; start < state.selectedIds.length; start += state.batchSize) {
    const ids = state.selectedIds.slice(start, start + state.batchSize);
    if (ids.every((id) => state.records[id]?.verified === true)) indexes.push(start / state.batchSize);
  }
  return indexes;
}

export async function loadIngestionCheckpoint(path, expected, resume) {
  if (!resume) return { state: newIngestionCheckpoint(expected), resumed: false };
  let raw;
  try { raw = await readFile(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return { state: newIngestionCheckpoint(expected), resumed: false };
    throw error;
  }
  let state;
  try { state = JSON.parse(raw); }
  catch { throw new Error("Corrupt ingestion checkpoint JSON."); }
  return { state: validateCheckpoint(state, expected), resumed: true };
}

export function recordCheckpointOutcome(state, id, outcome) {
  if (!state.selectedIds.includes(id) || !outcome ||
      !["inserted", "updated", "metadata-updated", "unchanged", "skipped", "reconciled", "failed"].includes(outcome.status) ||
      typeof outcome.verified !== "boolean") throw new Error("Invalid ingestion checkpoint outcome.");
  state.records[id] = { status: outcome.status, verified: outcome.verified,
    sourceHash: outcome.sourceHash ?? null };
  state.completedBatches = completedBatchIndexes(state);
  return state;
}

export async function writeIngestionCheckpoint(path, state) {
  const target = resolve(path);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(state), { encoding: "utf8", flag: "wx" });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
