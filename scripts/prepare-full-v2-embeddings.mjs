import { resolve } from "node:path";
import { env } from "@huggingface/transformers";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { APPROVED_FULL_V2_DATASET_HASH,
  prepareFullV2Embeddings } from "../lib/full-v2-local-prep.mjs";
import { datasetFingerprint } from "../lib/ingestion-checkpoint.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";

if (process.argv.length !== 2) {
  console.error("This local-only command takes no arguments.");
  process.exitCode = 1;
} else {
  try {
    env.allowRemoteModels = false;
    const file = resolve("data/all-movies.csv");
    const datasetHash = await datasetFingerprint(file);
    if (datasetHash !== APPROVED_FULL_V2_DATASET_HASH) {
      throw new Error("The reviewed source dataset fingerprint changed.");
    }
    const movies = await readUnifiedMovies(file);
    const provider = createEmbeddingProvider({ providerId: "local" });
    const result = await prepareFullV2Embeddings({ movies, provider, datasetHash,
      onProgress: (progress) => console.log(JSON.stringify(progress)) });
    if (await datasetFingerprint(file) !== datasetHash) {
      throw new Error("The source dataset changed during local preparation.");
    }
    console.log(JSON.stringify({ mode: "local-cache-only", databaseWrites: 0,
      openAiCalls: 0, ...result }, null, 2));
  } catch {
    console.error("Local embedding preparation stopped. Inspect the ignored checkpoint and cache.");
    process.exitCode = 1;
  }
}
