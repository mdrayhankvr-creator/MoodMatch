import test from "node:test";
import assert from "node:assert/strict";
import { benchmarkBand, MAX_BENCHMARK_MOVIES,
  selectBenchmarkSample, summarizeBenchmark } from "../lib/embedding-benchmark.mjs";

const record = (id, chunks, cache = "missing") => ({
  id: `movie_${id.toString(16).padStart(20, "0")}`, chunks, cache,
});

test("benchmark selection is deterministic, uncached, stratified, and bounded", () => {
  const candidates = [1, 2, 3, 4].map((id) => record(id, 1))
    .concat([5, 6, 7, 8].map((id) => record(id, 3)))
    .concat([9, 10, 11, 12].map((id) => record(id, 5)))
    .concat([record(13, 1, "reusable"), record(14, 9, "missing")]);
  const selected = selectBenchmarkSample(candidates);
  assert.deepEqual(selected, selectBenchmarkSample([...candidates].reverse()));
  assert.equal(selected.length, 9);
  assert.ok(selected.length <= MAX_BENCHMARK_MOVIES);
  assert.deepEqual(selected.map((item) => item.band), [
    "short", "short", "short", "medium", "medium", "medium", "long", "long", "long"]);
  assert.ok(selected.every((item) => item.id !== record(13, 1).id &&
    item.id !== record(14, 9).id && item.plannedChunks <= 8));
});

test("unsafe or incomplete benchmark samples fail before inference", () => {
  assert.equal(benchmarkBand(1), "short");
  assert.equal(benchmarkBand(2), "medium");
  assert.equal(benchmarkBand(4), "long");
  assert.throws(() => benchmarkBand(0), /Invalid benchmark chunk count/);
  assert.throws(() => selectBenchmarkSample([record(1, 1)]), /Insufficient uncached short/);
  assert.throws(() => selectBenchmarkSample([record(1, 1), record(1, 2)]), /unique IDs/);
});

test("throughput and extrapolation use only measured chunk timings", () => {
  const measurements = [
    { chunks: 2, chunkDurationsMs: [100, 200], inferenceMs: 305 },
    { chunks: 1, chunkDurationsMs: [300], inferenceMs: 302 },
  ];
  const result = summarizeBenchmark(measurements, 3_113, 1_090);
  assert.equal(result.movies, 2);
  assert.equal(result.chunks, 3);
  assert.equal(result.totalChunkProcessingMs, 600);
  assert.equal(result.totalMovieInferenceMs, 607);
  assert.equal(result.observedChunksPerSecond, 5);
  assert.equal(result.extrapolatedInferenceSeconds, 622.6);
  assert.deepEqual(result.observedExtremeRangeSeconds, { lower: 311.3, upper: 933.9 });
  assert.match(result.rangeMethod, /not a confidence interval/);
  assert.throws(() => summarizeBenchmark([{ chunks: 1,
    chunkDurationsMs: [NaN], inferenceMs: 1 }], 1, 1), /invalid/);
  assert.throws(() => summarizeBenchmark([{ chunks: 1, inferenceMs: 1 }], 1, 1), /invalid/);
  assert.throws(() => summarizeBenchmark(new Array(11).fill(measurements[0]), 1, 1), /Invalid benchmark/);
});
