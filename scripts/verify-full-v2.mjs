import { resolve } from "node:path";
import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { APPROVED_FULL_V2_DATASET_HASH } from "../lib/full-v2-ingestion.mjs";
import { verifyFullV2LiveState } from "../lib/full-v2-live-verification.mjs";
import { datasetFingerprint } from "../lib/ingestion-checkpoint.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";

if (process.argv.length !== 2) {
  console.error("This read-only verification command takes no arguments.");
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
    const db = getAstraDbRuntime(loadIngestionEnvironment());
    const result = await verifyFullV2LiveState({ db, movies, provider, datasetHash });
    console.log(JSON.stringify({ mode: "read-only", databaseWrites: 0, ...result }, null, 2));
  } catch (error) {
    const knownReasons = new Set([
      "Full-v2 scan requires 1,100 cache-verified documents.",
      "Full-v2 scan found missing or unexpected documents.",
      "Full-v2 scan found an unknown ID, duplicate, or content conflict.",
      "Full-v2 indexed metadata filter verification failed.",
      "Full-v2 vector similarity verification failed.",
      "The full-v2 cache coverage is incomplete.",
      "The legacy snapshot changed during full-v2 verification.",
      "The reviewed full-v2 source fingerprint changed.",
    ]);
    console.error(JSON.stringify({ error: "Full-v2 read-only verification failed.",
      reason: knownReasons.has(error?.message) ? error.message : safeAstraError(error),
      operation: /^[a-zA-Z][a-zA-Z0-9]*$/u.test(error?.operation ?? "")
        ? error.operation : "unknown",
      httpStatus: Number.isSafeInteger(error?.status) ? error.status : null }, null, 2));
    process.exitCode = 1;
  }
}
