import { freemem, totalmem } from "node:os";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "@huggingface/transformers";
import { createEmbeddingProvider } from "../lib/embedding-provider.mjs";
import { readUnifiedMovies, selectMovieSample } from "../lib/movie-ingestion-sample.mjs";
import { datasetFingerprint, DEFAULT_INGESTION_STATE,
  ingestionConfigurationFingerprint, loadIngestionCheckpoint } from "../lib/ingestion-checkpoint.mjs";
import { buildFullReadinessPlan, FULL_EXECUTION_ENABLED, inspectRemoteReadOnly,
  parsePreflightArgs } from "../lib/full-ingestion-readiness.mjs";
import { getAstraDbRuntime, safeAstraError } from "../lib/astra-runtime.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";

async function sampleCheckpointStatus(plan) {
  let raw;
  try { raw = JSON.parse(await readFile(DEFAULT_INGESTION_STATE, "utf8")); }
  catch (error) {
    return error.code === "ENOENT" ? "absent" : "incompatible; manual review required";
  }
  try {
    await loadIngestionCheckpoint(DEFAULT_INGESTION_STATE, {
      datasetHash: plan.datasetHash, configHash: ingestionConfigurationFingerprint(),
      selectedIds: plan.records.slice(0, 10).map((item) => item.id),
      batchSize: raw.batchSize,
    }, true);
    return "compatible; sample-only; remote revalidation required before any skip";
  } catch { return "incompatible; manual review required"; }
}

async function main() {
  const { remoteReadOnly } = parsePreflightArgs(process.argv.slice(2));
  // Tokenization loads the pinned local model from disk. Never download or infer in preflight.
  env.allowRemoteModels = false;
  const provider = createEmbeddingProvider({ providerId: "local" });
  const datasetFile = resolve("data/all-movies.csv");
  const movies = await readUnifiedMovies(datasetFile);
  const priorityMovies = await selectMovieSample(movies, provider, 5);
  const plan = await buildFullReadinessPlan({ movies, priorityMovies, provider,
    datasetHash: await datasetFingerprint(datasetFile) });
  const checkpoint = await sampleCheckpointStatus(plan);
  const remote = remoteReadOnly
    ? await inspectRemoteReadOnly(getAstraDbRuntime(loadIngestionEnvironment()), plan)
    : null;
  const report = {
    mode: remoteReadOnly ? "remote-read-only" : "local-only",
    executionEnabled: FULL_EXECUTION_ENABLED, inferenceCalls: 0, databaseWrites: 0,
    databaseReads: remoteReadOnly ? "read-only inventory and verification" : 0,
    dataset: plan.dataset, datasetHash: plan.datasetHash,
    configHash: plan.configHash,
    collection: plan.collection, dimensions: plan.dimensions, metric: plan.metric,
    provider: "local", model: plan.model, revision: plan.revision,
    embeddingVersion: plan.embeddingVersion,
    localModelFiles: "pinned model loaded with remote downloads disabled",
    coverage: plan.coverage,
    plannedBatchSize: plan.scheduling.batchSize,
    plannedConcurrency: plan.scheduling.concurrency,
    plannedBatches: plan.scheduling.batches.length,
    sampleCheckpoint: checkpoint,
    remote,
    expectedDatabaseWrites: remote ? remote.potentialWritesAfterApproval : "requires remote read-only preflight",
    resourcesAtPreflightBytes: { availableSystemMemory: freemem(),
      totalSystemMemory: totalmem(), processRss: process.memoryUsage().rss },
    remainingRequirements: ["explicit future approval and separate execution gate",
      "review per-article attribution and exceptional license notices",
      "verify Astra capacity, plan limits, and operational monitoring",
      "benchmark inference runtime and memory before scheduling"],
  };
  console.log(JSON.stringify(report, null, 2));
}

try { await main(); }
catch (error) {
  const connectionCodes = new Set(["EACCES", "EPERM", "ECONNREFUSED", "ECONNRESET",
    "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT"]);
  const message = /^DataAPI/u.test(error?.name ?? "") || error instanceof TypeError ||
    connectionCodes.has(error?.code)
    ? safeAstraError(error) : error?.message ?? "Preflight failed.";
  console.error(message);
  process.exitCode = 1;
}
