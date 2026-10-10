import { env } from "@huggingface/transformers";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { MigrationPlanError, parseMigrationArgs,
  planV2Migration } from "../lib/vector-migration-plan.mjs";

async function main() {
  parseMigrationArgs(process.argv.slice(2)); // --apply fails before credentials or DB access.
  env.allowRemoteModels = false;
  const provider = createEmbeddingProvider({ providerId: "local" });
  const movies = await readUnifiedMovies();
  const db = getAstraDbRuntime(loadIngestionEnvironment());
  const plan = await planV2Migration({ db, movies, provider });
  console.log(JSON.stringify(plan, null, 2));
}

try { await main(); }
catch (error) {
  const knownConfiguration = error instanceof MigrationPlanError ||
    error?.name === "CollectionConfigurationError" ||
    /^(?:Existing v2 collection|Expected 1100 unified movie records|ASTRA_DB_|\.env\.local)/u.test(error?.message ?? "");
  console.error(knownConfiguration ? error.message : safeAstraError(error));
  process.exitCode = 1;
}
