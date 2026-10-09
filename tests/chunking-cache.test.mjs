import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { chunkDescription, assertCompleteCoverage, normalizedDescription } from "../lib/chunking.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "../lib/embedding-provider.mjs";
import { cacheFilePath, makeCacheIdentity, readCachedEmbedding, writeCachedEmbedding } from "../lib/embedding-cache.mjs";
import { aggregateChunkVectors, embedDescriptionLocally } from "../lib/movie-embeddings.mjs";

const countCharacters = async (texts) => texts.map((text) => Array.from(text).length + 2);
const description = (plot) => ({ title: "A title", genre: "Drama", description: plot });
const settings = { maxTokens: 90, contentTokens: 55, overlapTokens: 10 };

async function withTempDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "moodmatch-m5b-"));
  try { return await callback(directory); }
  finally {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe test cleanup path.");
    await rm(directory, { recursive: true, force: true });
  }
}

function identity(text = "Title: A title\nPlot: A plot", modelId = LOCAL_MODEL_ID, providerId = "local") {
  return makeCacheIdentity({ recordId: "movie_1234567890abcdef1234", normalizedText: text,
    providerId, modelId, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: 2, chunkConfig: settings });
}

test("empty title or plot is rejected before chunking", async () => {
  await assert.rejects(chunkDescription(description(" "), countCharacters), /nonempty/u);
  await assert.rejects(chunkDescription({ title: " ", description: "A plot" }, countCharacters), /title/u);
  await assert.rejects(chunkDescription(description("A plot"), null), /tokenizer counter/u);
});

test("a short description and exact model-limit input use one complete chunk", async () => {
  const input = description("A short plot.");
  const length = Array.from(normalizedDescription(input).fullText).length + 2;
  const plan = await chunkDescription(input, countCharacters, { maxTokens: length, contentTokens: 20, overlapTokens: 3 });
  assert.equal(plan.chunks.length, 1);
  assert.equal(plan.chunks[0].inputTokens, length);
  assert.equal(plan.chunks[0].text, plan.fullText);
  assertCompleteCoverage(plan);
  const split = await chunkDescription(input, countCharacters, { maxTokens: length - 1, contentTokens: 20, overlapTokens: 3 });
  assert.ok(split.chunks.length > 1);
});

test("very long Unicode and punctuation preserve every normalized plot grapheme", async () => {
  const input = description(("A café 😀 e\u0301 sentence; another sentence! " + "好世界。 ").repeat(90));
  const first = await chunkDescription(input, countCharacters, settings);
  const second = await chunkDescription(input, countCharacters, settings);
  assert.deepEqual(first, second);
  assert.ok(first.chunks.length > 20);
  assertCompleteCoverage(first);
  assert.equal(first.chunks.map((chunk) => first.plot.slice(chunk.coreStart, chunk.coreEnd)).join(""), first.plot);
  assert.ok(first.chunks.every((chunk) => chunk.inputTokens <= settings.maxTokens));
  assert.ok(first.chunks.some((chunk) => chunk.spanStart < chunk.coreStart));
  assert.ok(first.chunks.every((chunk) => chunk.coreEnd > chunk.coreStart));
  const originalGraphemes = Array.from(new Intl.Segmenter("und", { granularity: "grapheme" }).segment(first.plot), (item) => item.segment);
  const coreGraphemes = first.chunks.flatMap((chunk) => Array.from(
    new Intl.Segmenter("und", { granularity: "grapheme" }).segment(first.plot.slice(chunk.coreStart, chunk.coreEnd)),
    (item) => item.segment));
  assert.deepEqual(coreGraphemes, originalGraphemes);
});

test("a long unbroken Unicode plot still advances without trailing duplicate-only chunks", async () => {
  const plan = await chunkDescription(description("😀".repeat(450)), countCharacters, settings);
  assertCompleteCoverage(plan);
  assert.ok(plan.chunks.length > 2);
  assert.ok(plan.chunks.every((chunk) => chunk.coreEnd > chunk.coreStart));
  assert.equal(plan.chunks.at(-1).coreEnd, plan.plot.length);
});

test("a prefix too large for even one grapheme fails explicitly", async () => {
  const input = { title: "Very long title ".repeat(12), description: "A plot that cannot fit." };
  await assert.rejects(chunkDescription(input, countCharacters, settings), /cannot fit a single/u);
});

test("weighted aggregation excludes overlap from weights and normalizes output", () => {
  const result = aggregateChunkVectors([{ weight: 3 }, { weight: 1 }], [[1, 0], [0, 1]], 2);
  assert.ok(Math.abs(result[0] - 3 / Math.sqrt(10)) < 1e-12);
  assert.ok(Math.abs(result[1] - 1 / Math.sqrt(10)) < 1e-12);
  assert.ok(Math.abs(Math.hypot(...result) - 1) < 1e-12);
  assert.throws(() => aggregateChunkVectors([{ weight: 1 }, { weight: 1 }], [[1, 0], [-1, 0]], 2), /zero or invalid norm/u);
  assert.throws(() => aggregateChunkVectors([{ weight: 1 }], [[0, 0]], 2), /zero or invalid vector norm/u);
  assert.throws(() => aggregateChunkVectors([{ weight: 1 }], [[NaN, 0]], 2), /invalid values/u);
});

test("cache misses, hits, content/model/provider invalidation, and corruption", () => withTempDirectory(async (root) => {
  const expected = [{ index: 0, coreStart: 0, coreEnd: 5, spanStart: 0, inputTokens: 10, weight: 5 }];
  const current = identity();
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "miss");
  await writeCachedEmbedding(root, current, expected, [1, 0]);
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "hit");
  assert.equal((await readCachedEmbedding(root, identity("Title: A title\nPlot: A changed plot"), expected)).status, "miss");
  assert.equal((await readCachedEmbedding(root, identity(undefined, "another-model"), expected)).status, "miss");
  assert.equal((await readCachedEmbedding(root, identity(undefined, LOCAL_MODEL_ID, "openai"), expected)).status, "miss");
  const differentChunking = makeCacheIdentity({ recordId: current.recordId,
    normalizedText: "Title: A title\nPlot: A plot", providerId: "local", modelId: LOCAL_MODEL_ID,
    modelRevision: LOCAL_MODEL_REVISION, dimensions: 2,
    chunkConfig: { ...settings, overlapTokens: settings.overlapTokens + 1 } });
  assert.equal((await readCachedEmbedding(root, differentChunking, expected)).status, "miss");
  assert.equal((await readCachedEmbedding(root, current, [{ ...expected[0], coreEnd: 4 }])).status, "invalid");
  const path = cacheFilePath(root, current);
  const data = JSON.parse(await readFile(path, "utf8"));
  data.vector[0] = 0.5;
  await writeFile(path, JSON.stringify(data));
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "invalid");
  await writeCachedEmbedding(root, current, expected, [1, 0]);
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "hit");
}));

test("interrupted temporary writes are ignored and do not damage the committed cache", () => withTempDirectory(async (root) => {
  const current = identity();
  const expected = [{ index: 0, coreStart: 0, coreEnd: 5, spanStart: 0, inputTokens: 10, weight: 5 }];
  await writeCachedEmbedding(root, current, expected, [1, 0]);
  const partial = cacheFilePath(root, current) + ".interrupted.tmp";
  await writeFile(partial, "{partial");
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "hit");
  await rename(cacheFilePath(root, current), partial + ".old");
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "miss");
  await writeCachedEmbedding(root, current, expected, [1, 0]);
  assert.equal((await readCachedEmbedding(root, current, expected)).status, "hit");
}));

test("service reuses a real cache hit and refuses an OpenAI provider before inference", () => withTempDirectory(async (root) => {
  let inferenceCalls = 0;
  let paidCalls = 0;
  const provider = {
    id: "local", modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, tokenCounts: countCharacters,
    embedText: async () => {
      inferenceCalls += 1;
      return { providerId: "local", modelId: LOCAL_MODEL_ID, dimensions: LOCAL_DIMENSIONS,
        embedding: [1, ...Array(LOCAL_DIMENSIONS - 1).fill(0)] };
    },
    embedOpenAI: async () => { paidCalls += 1; throw new Error("paid call"); },
  };
  const record = { id: "movie_1234567890abcdef1234", ...description("A genuine source plot.") };
  const first = await embedDescriptionLocally(record, provider, { cacheRoot: root });
  const second = await embedDescriptionLocally(record, provider, { cacheRoot: root });
  assert.equal(first.cacheStatus, "miss");
  assert.equal(second.cacheStatus, "hit");
  assert.equal(first.inferenceCalls, 1);
  assert.equal(second.inferenceCalls, 0);
  assert.equal(inferenceCalls, 1);
  assert.equal(paidCalls, 0);
  assert.equal((await embedDescriptionLocally({ ...record, description: "A changed plot." }, provider, { cacheRoot: root })).cacheStatus, "miss");
  await assert.rejects(embedDescriptionLocally(record, { ...provider, id: "openai" }, { cacheRoot: root }), /local provider/u);
  assert.equal(paidCalls, 0);
}));
