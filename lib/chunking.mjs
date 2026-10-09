import { buildEmbeddingInput } from "./embedding-runtime.mjs";
import { LOCAL_MAX_TOKENS } from "./embedding-provider.mjs";

export const DEFAULT_CHUNK_CONFIG = Object.freeze({
  maxTokens: LOCAL_MAX_TOKENS,
  contentTokens: 220,
  overlapTokens: 20,
});

function validateConfig(config) {
  const settings = { ...DEFAULT_CHUNK_CONFIG, ...config };
  if (![settings.maxTokens, settings.contentTokens, settings.overlapTokens].every(Number.isSafeInteger) ||
      settings.maxTokens < 4 || settings.maxTokens > LOCAL_MAX_TOKENS ||
      settings.contentTokens < 1 || settings.contentTokens > settings.maxTokens ||
      settings.overlapTokens < 0 || settings.overlapTokens >= settings.contentTokens) {
    throw new Error("Invalid local chunk configuration.");
  }
  return settings;
}

export function normalizedDescription(input) {
  const fullText = buildEmbeddingInput(input);
  const marker = "\nPlot: ";
  const markerAt = fullText.lastIndexOf(marker);
  if (markerAt < 0) throw new Error("Embedding input has no plot field.");
  return {
    fullText,
    prefix: fullText.slice(0, markerAt + marker.length),
    plot: fullText.slice(markerAt + marker.length),
  };
}

function graphemeBoundaries(text) {
  const boundaries = [0];
  for (const item of new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)) {
    boundaries.push(item.index + item.segment.length);
  }
  return boundaries;
}

function naturalEnd(plot, boundaries, startIndex, maximumIndex) {
  const floor = Math.max(startIndex + 1, maximumIndex - 64, startIndex + Math.floor((maximumIndex - startIndex) * 0.8));
  for (let index = maximumIndex; index >= floor; index -= 1) {
    const finalGrapheme = plot.slice(boundaries[index - 1], boundaries[index]);
    if (/[\s.!?;,]$/u.test(finalGrapheme)) return index;
  }
  return maximumIndex;
}

function requireCounts(counts, expected) {
  if (!Array.isArray(counts) || counts.length !== expected ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error("Tokenizer returned invalid chunk token counts.");
  }
  return counts;
}

export function assertCompleteCoverage(plan) {
  let next = 0;
  for (const [index, chunk] of plan.chunks.entries()) {
    if (chunk.index !== index || chunk.coreStart !== next || chunk.coreEnd <= next ||
        chunk.coreEnd > plan.plot.length || chunk.spanStart > chunk.coreStart ||
        chunk.spanStart < 0 || chunk.text !== plan.prefix + plan.plot.slice(chunk.spanStart, chunk.coreEnd) ||
        !Number.isSafeInteger(chunk.inputTokens) || chunk.inputTokens > plan.config.maxTokens ||
        !Number.isSafeInteger(chunk.weight) || chunk.weight < 1) {
      throw new Error("Chunk plan has a gap, overlap-only chunk, or invalid model input.");
    }
    next = chunk.coreEnd;
  }
  if (next !== plan.plot.length ||
      plan.chunks.map((chunk) => plan.plot.slice(chunk.coreStart, chunk.coreEnd)).join("") !== plan.plot) {
    throw new Error("Chunk plan does not cover the complete normalized plot.");
  }
}

/** The token counter must use the same local tokenizer as the inference provider. */
export async function chunkDescription(input, tokenCounts, config = {}) {
  if (typeof tokenCounts !== "function") throw new Error("A local tokenizer counter is required.");
  const settings = validateConfig(config);
  const { fullText, prefix, plot } = normalizedDescription(input);
  const [wholeTokens] = requireCounts(await tokenCounts([fullText]), 1);
  const weightOf = (start, end) => Math.max(1, Array.from(plot.slice(start, end).replace(/\s/gu, "")).length);

  if (wholeTokens <= settings.maxTokens) {
    const plan = {
      fullText, prefix, plot, config: settings,
      chunks: [{ index: 0, coreStart: 0, coreEnd: plot.length, spanStart: 0,
        text: fullText, inputTokens: wholeTokens, weight: weightOf(0, plot.length) }],
    };
    assertCompleteCoverage(plan);
    return plan;
  }

  const boundaries = graphemeBoundaries(plot);
  const chunks = [];
  let coreIndex = 0;
  while (coreIndex < boundaries.length - 1) {
    let overlapIndex = coreIndex;
    if (coreIndex > 0 && settings.overlapTokens > 0) {
      let low = 0;
      let high = coreIndex;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const overlap = plot.slice(boundaries[middle], boundaries[coreIndex]);
        const [count] = requireCounts(await tokenCounts([overlap]), 1);
        if (count <= settings.overlapTokens) high = middle;
        else low = middle + 1;
      }
      overlapIndex = low;
    }

    async function fits(endIndex) {
      const content = plot.slice(boundaries[overlapIndex], boundaries[endIndex]);
      const [contentCount, inputCount] = requireCounts(await tokenCounts([content, prefix + content]), 2);
      return contentCount <= settings.contentTokens && inputCount <= settings.maxTokens;
    }

    let best = coreIndex;
    let low = coreIndex + 1;
    let high = boundaries.length - 1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (await fits(middle)) {
        best = middle;
        low = middle + 1;
      } else high = middle - 1;
    }
    if (best === coreIndex && overlapIndex < coreIndex) {
      overlapIndex = coreIndex;
      low = coreIndex + 1;
      high = boundaries.length - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        if (await fits(middle)) {
          best = middle;
          low = middle + 1;
        } else high = middle - 1;
      }
    }
    if (best === coreIndex) throw new Error(`Chunk ${chunks.length} cannot fit a single plot grapheme within the token limits.`);
    let endIndex = naturalEnd(plot, boundaries, coreIndex, best);
    if (!(await fits(endIndex))) endIndex = best;
    const coreStart = boundaries[coreIndex];
    const coreEnd = boundaries[endIndex];
    const spanStart = boundaries[overlapIndex];
    const text = prefix + plot.slice(spanStart, coreEnd);
    const [inputTokens] = requireCounts(await tokenCounts([text]), 1);
    if (inputTokens > settings.maxTokens) throw new Error("Assembled chunk exceeds the model token limit.");
    chunks.push({ index: chunks.length, coreStart, coreEnd, spanStart, text, inputTokens,
      weight: weightOf(coreStart, coreEnd) });
    coreIndex = endIndex;
  }
  const plan = { fullText, prefix, plot, config: settings, chunks };
  assertCompleteCoverage(plan);
  const finalCounts = requireCounts(await tokenCounts([
    ...chunks.map((chunk) => chunk.text),
    ...chunks.map((chunk) => plot.slice(chunk.spanStart, chunk.coreEnd)),
  ]), chunks.length * 2);
  if (chunks.some((chunk, index) => finalCounts[index] > settings.maxTokens ||
      finalCounts[index] !== chunk.inputTokens ||
      finalCounts[index + chunks.length] > settings.contentTokens)) {
    throw new Error("Final tokenizer verification failed for a chunk.");
  }
  return plan;
}
