import { createHash } from "node:crypto";

export const BENCHMARK_PER_BAND = 3;
export const MAX_BENCHMARK_MOVIES = 10;
export const MAX_BENCHMARK_CHUNKS_PER_MOVIE = 8;

function rank(id) {
  return createHash("sha256").update(id).digest("hex");
}

export function benchmarkBand(chunks) {
  if (!Number.isSafeInteger(chunks) || chunks < 1) throw new Error("Invalid benchmark chunk count.");
  if (chunks === 1) return "short";
  if (chunks <= 3) return "medium";
  return "long";
}

/** Fixed nine-record sample. Long candidates are capped to bound real inference work. */
export function selectBenchmarkSample(records) {
  if (!Array.isArray(records) || new Set(records.map((item) => item.id)).size !== records.length) {
    throw new Error("Benchmark candidates must have unique IDs.");
  }
  const buckets = { short: [], medium: [], long: [] };
  for (const record of records) {
    if (record.cache !== "missing") continue;
    const band = benchmarkBand(record.chunks);
    if (record.chunks <= MAX_BENCHMARK_CHUNKS_PER_MOVIE) buckets[band].push(record);
  }
  const selected = [];
  for (const band of ["short", "medium", "long"]) {
    if (buckets[band].length < BENCHMARK_PER_BAND) {
      throw new Error(`Insufficient uncached ${band} benchmark candidates.`);
    }
    buckets[band].sort((a, b) => {
      const left = rank(a.id);
      const right = rank(b.id);
      return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
    });
    selected.push(...buckets[band].slice(0, BENCHMARK_PER_BAND)
      .map((record) => ({ id: record.id, band, plannedChunks: record.chunks })));
  }
  if (selected.length > MAX_BENCHMARK_MOVIES) throw new Error("Benchmark movie cap exceeded.");
  return selected;
}

export function summarizeBenchmark(measurements, remainingChunks, remainingEmbeddings) {
  if (!Array.isArray(measurements) || measurements.length < 1 ||
      measurements.length > MAX_BENCHMARK_MOVIES ||
      !Number.isSafeInteger(remainingChunks) || remainingChunks < 0 ||
      !Number.isSafeInteger(remainingEmbeddings) || remainingEmbeddings < 0) {
    throw new Error("Invalid benchmark measurements or remaining workload.");
  }
  if (measurements.some((item) => !Array.isArray(item?.chunkDurationsMs) ||
      item.chunkDurationsMs.length !== item.chunks ||
      !Number.isFinite(item.inferenceMs) || item.inferenceMs <= 0)) {
    throw new Error("Benchmark timings are missing or invalid.");
  }
  const chunkMs = measurements.flatMap((item) => item.chunkDurationsMs ?? []);
  if (chunkMs.length === 0 || chunkMs.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error("Benchmark timings are missing or invalid.");
  }
  const totalChunkProcessingMs = chunkMs.reduce((sum, value) => sum + value, 0);
  const totalMovieInferenceMs = measurements.reduce((sum, item) => sum + item.inferenceMs, 0);
  const secondsPerChunk = totalChunkProcessingMs / chunkMs.length / 1000;
  return {
    movies: measurements.length, chunks: chunkMs.length,
    totalChunkProcessingMs, totalMovieInferenceMs,
    observedChunksPerSecond: 1 / secondsPerChunk,
    remainingEmbeddings, remainingChunks,
    extrapolatedInferenceSeconds: remainingChunks * secondsPerChunk,
    observedExtremeRangeSeconds: {
      lower: remainingChunks * Math.min(...chunkMs) / 1000,
      upper: remainingChunks * Math.max(...chunkMs) / 1000,
    },
    rangeMethod: "Remaining chunks multiplied by the fastest and slowest observed chunk times; not a confidence interval.",
    exclusions: "Model startup, full-dataset tokenization, cache writes, retries, database operations, and future system contention are excluded.",
  };
}
