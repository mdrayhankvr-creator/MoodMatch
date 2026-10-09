import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { chunkDescription } from "../lib/chunking.mjs";
import { makeCacheIdentity, readCachedEmbedding, DEFAULT_CACHE_ROOT } from "../lib/embedding-cache.mjs";
import { chunkMetadata, embedMovieLocally } from "../lib/movie-embeddings.mjs";
import { readUnifiedMovies, selectMovieSample } from "../lib/movie-ingestion-sample.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { initializeMovieCollection, ingestMovieBatch, validateMovieRecord, LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";

function parseArgs(args) {
  let apply = false;
  let limit = 5;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--apply" && !apply) apply = true;
    else if (args[i] === "--limit" && /^[2-5]$/u.test(args[i + 1] ?? "")) limit = Number(args[++i]);
    else throw new Error("Use [--apply] [--limit 2..5]. More than five records is prohibited.");
  }
  return { apply, limit };
}

async function plannedEmbedding(movie, provider) {
  const plan = await chunkDescription({ title: movie.title, genre: movie.genre, description: movie.plot }, provider.tokenCounts);
  const identity = makeCacheIdentity({ recordId: movie.id, normalizedText: plan.fullText,
    providerId: provider.id, modelId: provider.modelId, modelRevision: provider.modelRevision,
    dimensions: provider.dimensions, chunkConfig: plan.config });
  const cache = await readCachedEmbedding(DEFAULT_CACHE_ROOT, identity, chunkMetadata(plan));
  return { id: movie.id, chunks: plan.chunks.length, cache: cache.status, sourceHash: identity.sourceHash };
}

async function main() {
  const { apply, limit } = parseArgs(process.argv.slice(2));
  const provider = createEmbeddingProvider({ providerId: "local" });
  const movies = await readUnifiedMovies();
  const sample = await selectMovieSample(movies, provider, limit);
  const plans = [];
  for (const movie of sample) {
    validateMovieRecord(movie);
    plans.push(await plannedEmbedding(movie, provider));
  }
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", collection: LOCAL_COLLECTION, movieCount: sample.length,
      recordsValidated: sample.length, targetDimensions: provider.dimensions,
      collectionConfiguration: "checked-on-apply",
      cacheHits: plans.filter((item) => item.cache === "hit").length,
      missingEmbeddings: plans.filter((item) => item.cache !== "hit").length,
      planned: plans.map(({ id, chunks, cache }) => ({ id, chunks, cache })),
      collectionWrites: 0, documentWrites: 0, inferenceCalls: 0 }, null, 2));
    return;
  }

  const db = getAstraDbRuntime(loadIngestionEnvironment());
  const { collection, state } = await initializeMovieCollection(db, { apply: true });
  const results = (await ingestMovieBatch(collection, sample, (movie) => embedMovieLocally(movie, provider)))
    .map(({ error, ...result }) => error ? { ...result, reason: safeAstraError(error) } : result);
  const failed = results.filter((item) => item.status === "failed").length;
  console.log(JSON.stringify({ mode: "apply", collection: LOCAL_COLLECTION, collectionState: state,
    attempted: sample.length, inserted: results.filter((item) => (item.writeStatus ?? item.status) === "inserted").length,
    updated: results.filter((item) => (item.writeStatus ?? item.status) === "updated").length,
    metadataUpdated: results.filter((item) => (item.writeStatus ?? item.status) === "metadata-updated").length,
    unchanged: results.filter((item) => item.status === "unchanged").length,
    failed, results }, null, 2));
  if (failed) process.exitCode = 1;
}

try { await main(); }
catch (error) {
  console.error(error?.message?.startsWith("ASTRA_DB_") || error?.message?.startsWith(".env.local")
    ? error.message : safeAstraError(error));
  process.exitCode = 1;
}
