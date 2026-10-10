import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { MigrationPlanError, parseMigrationArgs,
  planV2Migration } from "../lib/vector-migration-plan.mjs";
import { assertV2MigrationApproved, MigrationExecutionError,
  executeV2Migration } from "../lib/vector-v2-live-migration.mjs";

async function main() {
  const { mode } = parseMigrationArgs(process.argv.slice(2));
  if (mode === "apply") assertV2MigrationApproved(); // Before credentials or DB access.
  env.allowRemoteModels = false;
  const provider = createEmbeddingProvider({ providerId: "local" });
  const movies = await readUnifiedMovies();
  const db = getAstraDbRuntime(loadIngestionEnvironment());
  const result = mode === "apply"
    ? await executeV2Migration({ db, movies, provider })
    : await planV2Migration({ db, movies, provider });
  console.log(JSON.stringify(result, null, 2));
}

try { await main(); }
catch (error) {
  if (error instanceof MigrationExecutionError) {
    const cause = error.cause;
    const knownCause = cause instanceof MigrationPlanError ||
      cause?.name === "CollectionConfigurationError";
    console.error(JSON.stringify({
      error: knownCause ? cause.message : safeAstraError(cause),
      phase: error.phase,
      completed: error.results.length,
      results: error.results,
    }, null, 2));
    process.exitCode = 1;
  } else {
    const knownConfiguration = error instanceof MigrationPlanError ||
      error?.name === "CollectionConfigurationError" ||
      /^(?:Existing v2 collection|Expected 1100 unified movie records|ASTRA_DB_|\.env\.local)/u.test(error?.message ?? "");
    console.error(knownConfiguration ? error.message : safeAstraError(error));
    process.exitCode = 1;
  }
}
