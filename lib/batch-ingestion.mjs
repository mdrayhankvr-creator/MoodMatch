import { createHash } from "node:crypto";
import { DataAPIHttpError, DataAPIResponseError, DataAPITimeoutError } from "@datastax/astra-db-ts";
import { makeMovieVectorDocument, upsertMovieVector, verifyMovieVector,
  validateMovieRecord, ReadBackMismatchError } from "./movie-vector-store.mjs";
import { loadIngestionCheckpoint, recordCheckpointOutcome,
  writeIngestionCheckpoint } from "./ingestion-checkpoint.mjs";

export const MAX_BATCH_RECORDS = 10;
const MAX_DOCUMENT_CHARACTERS = 4_000_000;
const MAX_ATTEMPTS = 3;
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH",
  "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

export function validateBatchBounds(limit, batchSize) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_RECORDS ||
      !Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_RECORDS) {
    throw new Error("Batch limit and size must each be between 1 and 10.");
  }
}

export function parseBatchArgs(args) {
  const settings = { apply: false, limit: 10, batchSize: 10, resume: false, inferMissing: false };
  let explicitDryRun = false;
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (seen.has(flag)) throw new Error(`Duplicate batch option: ${flag}.`);
    seen.add(flag);
    if (flag === "--apply") settings.apply = true;
    else if (flag === "--dry-run") explicitDryRun = true;
    else if (flag === "--resume") settings.resume = true;
    else if (flag === "--infer-missing") settings.inferMissing = true;
    else if (flag === "--limit" || flag === "--batch-size") {
      const value = args[++index];
      if (!/^(?:[1-9]|10)$/u.test(value ?? "")) throw new Error(`${flag} must be 1..10.`);
      settings[flag === "--limit" ? "limit" : "batchSize"] = Number(value);
    } else throw new Error("Use [--dry-run] or --apply [--limit 1..10] [--batch-size 1..10] [--resume] [--infer-missing].");
  }
  if ((settings.apply && explicitDryRun) || (!settings.apply && (settings.resume || settings.inferMissing))) {
    throw new Error("--resume and --infer-missing require --apply; --dry-run cannot be combined with --apply.");
  }
  validateBatchBounds(settings.limit, settings.batchSize);
  return settings;
}

function rank(movie) {
  return createHash("sha256").update(movie.id).digest("hex");
}

export function deterministicMovieOrder(movies, priorityMovies) {
  const ids = new Set();
  for (const movie of movies) {
    validateMovieRecord(movie);
    if (ids.has(movie.id)) throw new Error(`Duplicate movie ID in unified dataset: ${movie.id}.`);
    ids.add(movie.id);
  }
  const priorityIds = new Set(priorityMovies.map((movie) => movie.id));
  if (priorityIds.size !== priorityMovies.length || [...priorityIds].some((id) => !ids.has(id))) {
    throw new Error("Priority sample contains unknown or duplicate movie IDs.");
  }
  return [...priorityMovies, ...movies.filter((movie) => !priorityIds.has(movie.id)).sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
  })];
}

export function isRetryableAstraError(error) {
  const pending = [error];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (current instanceof DataAPITimeoutError ||
        (current instanceof DataAPIHttpError && ([408, 429].includes(current.status) || current.status >= 500)) ||
        NETWORK_CODES.has(current.code)) return true;
    if (current instanceof DataAPIResponseError && current.errorDescriptors?.some((item) =>
      /(?:RATE_LIMIT|OVERLOAD|UNAVAILABLE|TIMEOUT)/iu.test(item.errorCode ?? ""))) return true;
    pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors);
  }
  return false;
}

export class RetryExhaustedError extends Error {
  constructor() {
    super("Astra DB operation exhausted bounded retries.");
    this.name = "RetryExhaustedError";
  }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withAstraRetry(operation, { sleep = defaultSleep, attempts = MAX_ATTEMPTS } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (!isRetryableAstraError(error)) throw error;
      if (attempt === attempts) throw new RetryExhaustedError();
      await sleep(300 * 2 ** (attempt - 1));
    }
  }
}

async function writeAndVerify(collection, document, sleep) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let writeStatus;
    try { writeStatus = await upsertMovieVector(collection, document); }
    catch (error) {
      if (!isRetryableAstraError(error)) throw error;
      // A timed-out upsert may have committed remotely. Read before retrying it.
      try {
        await withAstraRetry(() => verifyMovieVector(collection, document), { sleep });
        return "reconciled";
      } catch (readError) {
        if (!(readError instanceof ReadBackMismatchError) &&
            !(readError instanceof RetryExhaustedError)) throw readError;
      }
      if (attempt === MAX_ATTEMPTS) throw new RetryExhaustedError();
      await sleep(300 * 2 ** (attempt - 1));
      continue;
    }
    await withAstraRetry(() => verifyMovieVector(collection, document), { sleep });
    return writeStatus;
  }
}

/** At most ten sequential document attempts; checkpoint entries never bypass remote verification. */
export async function runControlledBatch({ collection, movies, prepareEmbedding,
  checkpointPath, datasetHash, configHash, batchSize = 10, resume = false,
  sleep = defaultSleep, onProgress = () => {} }) {
  validateBatchBounds(movies.length, batchSize);
  if (!collection || typeof prepareEmbedding !== "function") throw new Error("Batch dependencies are missing.");
  const ids = new Set();
  for (const movie of movies) {
    validateMovieRecord(movie);
    if (ids.has(movie.id)) throw new Error("Batch contains duplicate movie IDs.");
    ids.add(movie.id);
  }
  const expected = { datasetHash, configHash, selectedIds: movies.map((movie) => movie.id), batchSize };
  const { state, resumed } = await loadIngestionCheckpoint(checkpointPath, expected, resume);
  await writeIngestionCheckpoint(checkpointPath, state);
  const results = [];
  for (let start = 0; start < movies.length; start += batchSize) {
    for (const movie of movies.slice(start, start + batchSize)) {
      let sourceHash = null;
      let status = "failed";
      let error = null;
      try {
        const embedding = await prepareEmbedding(movie);
        const document = makeMovieVectorDocument(movie, embedding);
        sourceHash = document.content_hash;
        if (JSON.stringify(document).length > MAX_DOCUMENT_CHARACTERS) {
          throw new Error("Movie document exceeds the Data API character limit.");
        }
        if (resume && state.records[movie.id]?.verified &&
            state.records[movie.id].sourceHash === sourceHash) {
          try {
            await withAstraRetry(() => verifyMovieVector(collection, document), { sleep });
            status = "skipped";
          } catch (readError) {
            if (!(readError instanceof ReadBackMismatchError)) throw readError;
          }
        }
        if (status !== "skipped") status = await writeAndVerify(collection, document, sleep);
      } catch (caught) { error = caught; }
      const verified = !error;
      recordCheckpointOutcome(state, movie.id, { status, verified, sourceHash });
      await writeIngestionCheckpoint(checkpointPath, state);
      const result = { id: movie.id, status, verified,
        ...(error ? { errorKind: error.name ?? "Error" } : {}) };
      results.push(result);
      onProgress(result);
      if (results.length < movies.length) await sleep(100);
    }
  }
  return { resumed, results, completedBatches: state.completedBatches,
    inserted: results.filter((item) => item.status === "inserted").length,
    updated: results.filter((item) => ["updated", "metadata-updated"].includes(item.status)).length,
    skipped: results.filter((item) => ["unchanged", "skipped"].includes(item.status)).length,
    reconciled: results.filter((item) => item.status === "reconciled").length,
    failed: results.filter((item) => !item.verified).length,
    verified: results.filter((item) => item.verified).length };
}
