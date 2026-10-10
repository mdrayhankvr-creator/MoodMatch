import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { MigrationPlanError, MigrationReadError, parseMigrationArgs,
  planV2Migration } from "../lib/vector-migration-plan.mjs";
import { assertV2MigrationApproved, MigrationExecutionError, MigrationOperationError,
  sanitizeMigrationFailure,
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
    console.error(JSON.stringify({
      error: "Controlled v2 migration stopped; reconcile by dry-run before any future write.",
      phase: error.phase,
      diagnostic: sanitizeMigrationFailure(error),
      completed: error.results.length,
      results: error.results,
    }, null, 2));
    process.exitCode = 1;
  } else if (error instanceof MigrationOperationError || error instanceof MigrationReadError) {
    console.error(JSON.stringify(sanitizeMigrationFailure(error), null, 2));
    process.exitCode = 1;
  } else {
    const knownConfiguration = error instanceof MigrationPlanError ||
      error?.name === "CollectionConfigurationError";
    console.error(knownConfiguration ? error.message : safeAstraError(error));
    process.exitCode = 1;
  }
}
