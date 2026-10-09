import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { readUnifiedMovies, selectMovieSample } from "../lib/movie-ingestion-sample.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { initializeMovieCollection, searchMovieVectors, LOCAL_COLLECTION } from "../lib/movie-vector-store.mjs";

try {
  const movies = await readUnifiedMovies();
  const sample = await selectMovieSample(movies, createEmbeddingProvider({ providerId: "local" }), 5);
  const db = getAstraDbRuntime(loadIngestionEnvironment());
  const { collection, state } = await initializeMovieCollection(db);
  if (!collection) throw new Error("Local movie collection is missing.");
  const results = await searchMovieVectors(collection, sample[0].id, 5);
  console.log(JSON.stringify({ collection: LOCAL_COLLECTION, collectionState: state,
    sampleId: sample[0].id, results }, null, 2));
} catch (error) {
  console.error(error?.message?.startsWith("ASTRA_DB_") || error?.message?.startsWith(".env.local")
    ? error.message : safeAstraError(error));
  process.exitCode = 1;
}
