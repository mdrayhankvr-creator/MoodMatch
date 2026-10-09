import { cpus, platform, arch, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { env, pipeline } from "@huggingface/transformers";
import { createEmbeddingProvider, LOCAL_DIMENSIONS, LOCAL_MODEL_ID,
  LOCAL_MODEL_REVISION, validateEmbeddingVectors } from "../lib/embedding-provider.mjs";
import { readUnifiedMovies, selectMovieSample } from "../lib/movie-ingestion-sample.mjs";
import { datasetFingerprint } from "../lib/ingestion-checkpoint.mjs";
import { buildFullReadinessPlan } from "../lib/full-ingestion-readiness.mjs";
import { aggregateChunkVectors, inspectMovieCache } from "../lib/movie-embeddings.mjs";
import { selectBenchmarkSample, summarizeBenchmark } from "../lib/embedding-benchmark.mjs";

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("The benchmark accepts no options and always caps inference at nine movies.");
  }
  env.allowRemoteModels = false;
  let sampledPeakRssBytes = process.memoryUsage().rss;
  const sampleMemory = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  };
  const memorySampler = setInterval(sampleMemory, 25);
  let modelInitializationMs;
  const provider = createEmbeddingProvider({ providerId: "local",
    loadLocalModel: async (modelId) => {
      const start = performance.now();
      const model = await pipeline("feature-extraction", modelId,
        { device: "cpu", revision: LOCAL_MODEL_REVISION });
      modelInitializationMs = performance.now() - start;
      sampleMemory();
      return model;
    } });
  try {
    const initialRssBytes = process.memoryUsage().rss;
    const setupStart = performance.now();
    const movies = await readUnifiedMovies();
    const priorityMovies = await selectMovieSample(movies, provider, 5);
    const plan = await buildFullReadinessPlan({ movies, priorityMovies, provider,
      datasetHash: await datasetFingerprint("data/all-movies.csv") });
    const candidates = selectBenchmarkSample(plan.records);
    const selectionMs = performance.now() - setupStart;
    const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
    const afterModelRssBytes = process.memoryUsage().rss;
    const measurements = [];
    const inferenceStart = performance.now();
    const cpuStart = process.cpuUsage();
    for (const candidate of candidates) {
      const movie = moviesById.get(candidate.id);
      const inspected = await inspectMovieCache(movie, provider);
      if (inspected.cached.status !== "miss" ||
          inspected.plan.chunks.length !== candidate.plannedChunks) {
        throw new Error(`Benchmark cache or chunk plan changed for ${candidate.id}.`);
      }
      const movieStart = performance.now();
      const vectors = [];
      const chunkDurationsMs = [];
      for (const chunk of inspected.plan.chunks) {
        const start = performance.now();
        const result = await provider.embedText(chunk.text);
        const durationMs = performance.now() - start;
        if (result.providerId !== "local" || result.modelId !== LOCAL_MODEL_ID ||
            result.dimensions !== LOCAL_DIMENSIONS) {
          throw new Error(`Incompatible local inference result for ${candidate.id}.`);
        }
        validateEmbeddingVectors([result.embedding], 1, LOCAL_DIMENSIONS);
        vectors.push(result.embedding);
        chunkDurationsMs.push(durationMs);
        sampleMemory();
      }
      const embedding = aggregateChunkVectors(inspected.plan.chunks, vectors);
      validateEmbeddingVectors([embedding], 1, LOCAL_DIMENSIONS);
      const norm = Math.hypot(...embedding);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
        throw new Error(`Non-unit local vector for ${candidate.id}.`);
      }
      measurements.push({ id: movie.id, title: movie.title, band: candidate.band,
        plotCharacters: [...movie.plot].length, chunks: inspected.plan.chunks.length,
        inputTokens: inspected.plan.chunks.reduce((sum, chunk) => sum + chunk.inputTokens, 0),
        chunkDurationsMs, inferenceMs: performance.now() - movieStart,
        vectorDimensions: embedding.length, vectorNorm: norm });
      sampleMemory();
    }
    const cpu = process.cpuUsage(cpuStart);
    const inferenceWallMs = performance.now() - inferenceStart;
    const summary = summarizeBenchmark(measurements,
      plan.coverage.inferenceChunks, plan.coverage.inferenceRecords);
    console.log(JSON.stringify({ mode: "local-inference-benchmark",
      benchmarkMovieCap: 9, cacheWrites: 0, databaseReads: 0,
      databaseWrites: 0, openaiRequests: 0,
      datasetHash: plan.datasetHash, model: LOCAL_MODEL_ID,
      revision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
      hardware: { platform: platform(), architecture: arch(),
        logicalCpuCount: cpus().length, cpuModel: cpus()[0]?.model ?? null,
        totalSystemMemoryBytes: totalmem(), nodeVersion: process.version },
      modelInitializationMs, candidatePlanningMs: selectionMs,
      initialRssBytes, afterModelRssBytes, sampledPeakRssBytes,
      inferenceWallMs, inferenceCpuUserMs: cpu.user / 1000,
      inferenceCpuSystemMs: cpu.system / 1000,
      candidateCounts: { reusable: plan.coverage.reusable,
        missing: plan.coverage.missing, stale: plan.coverage.stale,
        invalid: plan.coverage.invalid },
      measurements, summary }, null, 2));
  } finally {
    clearInterval(memorySampler);
  }
}

try { await main(); }
catch (error) {
  console.error(error?.message ?? "Local inference benchmark failed.");
  process.exitCode = 1;
}
