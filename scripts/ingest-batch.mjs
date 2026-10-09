import { resolve } from "node:path";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { embedMovieLocally, inspectMovieCache } from "../lib/movie-embeddings.mjs";
import { readUnifiedMovies, selectMovieSample } from "../lib/movie-ingestion-sample.mjs";
import { deterministicMovieOrder, parseBatchArgs, runControlledBatch,
  withAstraRetry } from "../lib/batch-ingestion.mjs";
import { datasetFingerprint, ingestionConfigurationFingerprint,
  DEFAULT_INGESTION_STATE } from "../lib/ingestion-checkpoint.mjs";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { initializeMovieCollection, LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";

async function main() {
  const settings = parseBatchArgs(process.argv.slice(2));
  const provider = createEmbeddingProvider({ providerId: "local" });
  const file = resolve("data/all-movies.csv");
  const movies = await readUnifiedMovies(file);
  const priority = await selectMovieSample(movies, provider, 5);
  const ordered = deterministicMovieOrder(movies, priority);
  const selected = ordered.slice(0, settings.limit);
  const datasetHash = await datasetFingerprint(file);
  const configHash = ingestionConfigurationFingerprint();

  if (!settings.apply) {
    const cache = [];
    for (const movie of selected) {
      const inspected = await inspectMovieCache(movie, provider);
      cache.push({ id: movie.id, chunks: inspected.plan.chunks.length,
        cache: inspected.cached.status });
    }
    console.log(JSON.stringify({ mode: "dry-run", datasetMovies: movies.length,
      selected: selected.length, batchSize: settings.batchSize,
      selectedBatches: Math.ceil(selected.length / settings.batchSize),
      futureFullDatasetBatches: Math.ceil(movies.length / settings.batchSize),
      collection: LOCAL_COLLECTION, cacheHits: cache.filter((item) => item.cache === "hit").length,
      cacheMissing: cache.filter((item) => item.cache === "miss").length,
      cacheInvalid: cache.filter((item) => item.cache === "invalid").length,
      selectedChunks: cache.reduce((sum, item) => sum + item.chunks, 0),
      planned: cache, inferenceCalls: 0, databaseReads: 0, databaseWrites: 0 }, null, 2));
    return;
  }

  const db = getAstraDbRuntime(loadIngestionEnvironment());
  const { collection } = await withAstraRetry(() => initializeMovieCollection(db));
  if (!collection) throw new Error("Local 384-dimensional movie collection is missing; batch ingestion will not create it.");
  const collectionCountBefore = await withAstraRetry(() => collection.countDocuments({}, 11));
  const summary = await runControlledBatch({ collection, movies: selected,
    prepareEmbedding: (movie) => embedMovieLocally(movie, provider,
      { allowInference: settings.inferMissing, rejectInvalidCache: true }),
    checkpointPath: DEFAULT_INGESTION_STATE, datasetHash, configHash,
    batchSize: settings.batchSize, resume: settings.resume,
    onProgress: ({ id, status, verified, errorKind }) =>
      console.log(JSON.stringify({ id, status, verified, ...(errorKind ? { errorKind } : {}) })) });
  const collectionCountAfter = await withAstraRetry(() => collection.countDocuments({}, 11));
  console.log(JSON.stringify({ mode: "apply", selected: selected.length,
    batchSize: settings.batchSize, inferenceForMissingEnabled: settings.inferMissing,
    checkpointResumed: summary.resumed, completedBatches: summary.completedBatches,
    collectionCountBefore, collectionCountAfter,
    countCappedAtEleven: collectionCountBefore === 11 || collectionCountAfter === 11,
    inserted: summary.inserted, updated: summary.updated, skipped: summary.skipped,
    reconciled: summary.reconciled, failed: summary.failed, verified: summary.verified }, null, 2));
  if (summary.failed) process.exitCode = 1;
}

try { await main(); }
catch (error) {
  const configurationMessage = error?.message?.startsWith("ASTRA_DB_") ||
    error?.message?.startsWith(".env.local") ||
    error?.message?.startsWith("Incompatible ingestion checkpoint") ||
    error?.message?.startsWith("Corrupt ingestion checkpoint") ||
    error?.message?.startsWith("Local 384-dimensional") ||
    error?.message?.startsWith("--");
  console.error(configurationMessage ? error.message : safeAstraError(error));
  process.exitCode = 1;
}
