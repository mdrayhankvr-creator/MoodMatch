import { resolve } from "node:path";
import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { assertFullV2ApplyApproved, executeFullV2Ingestion,
  FULL_V2_CHECKPOINT_PATH, loadFullV2Checkpoint, parseFullV2Args,
  planFullV2Ingestion, reconcileCheckpointWithRemote,
  summarizeFullV2DryRun } from "../lib/full-v2-ingestion.mjs";
import { datasetFingerprint } from "../lib/ingestion-checkpoint.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { sanitizeMigrationFailure } from "../lib/vector-v2-live-migration.mjs";

async function main() {
  const { mode } = parseFullV2Args(process.argv.slice(2));
  if (mode === "apply") assertFullV2ApplyApproved(); // Before files, credentials, or DB access.
  env.allowRemoteModels = false;
  const file = resolve("data/all-movies.csv");
  const movies = await readUnifiedMovies(file);
  const datasetHash = await datasetFingerprint(file);
  const provider = createEmbeddingProvider({ providerId: "local" });
  const db = getAstraDbRuntime(loadIngestionEnvironment());
  if (mode === "dry-run") {
    const plan = await planFullV2Ingestion({ db, movies, provider, datasetHash });
    const { state, resumed } = await loadFullV2Checkpoint(FULL_V2_CHECKPOINT_PATH,
      plan.expectedCheckpoint);
    reconcileCheckpointWithRemote(state, plan.inventory.existingIds);
    console.log(JSON.stringify(summarizeFullV2DryRun(plan, resumed), null, 2));
    return;
  }
  const result = await executeFullV2Ingestion({ db, movies, provider, datasetHash,
    onProgress: ({ id, status }) => console.log(JSON.stringify({ id, status })) });
  console.log(JSON.stringify({ mode: "apply", ...result }, null, 2));
}

try { await main(); }
catch (error) {
  const diagnostic = sanitizeMigrationFailure(error);
  console.error(JSON.stringify({ error: "Full-v2 ingestion stopped; inspect the remote inventory and checkpoint.",
    category: diagnostic.category, operation: diagnostic.operation,
    httpStatus: diagnostic.httpStatus, apiCode: diagnostic.apiCode,
    detail: safeAstraError(error) }, null, 2));
  process.exitCode = 1;
}
