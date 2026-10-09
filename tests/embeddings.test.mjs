import assert from "node:assert/strict";
import { test } from "node:test";
import OpenAI from "openai";
import {
  EMBEDDING_DIMENSIONS, buildEmbeddingInput, buildMovieEmbeddingInput,
  embedText, embedTexts, embeddingContentHash, getEmbeddingModel, getOpenAIClient,
} from "../lib/embedding-runtime.mjs";

const model = "text-embedding-3-small";
const vector = (value = 0.1) => Array(EMBEDDING_DIMENSIONS).fill(value);
const response = (items, tokens = 12) => ({
  object: "list",
  model,
  data: items.map(([index, embedding]) => ({ object: "embedding", index, embedding })),
  usage: { prompt_tokens: tokens, total_tokens: tokens },
});

test("movie text and content hash are stable and exclude unrelated fields", () => {
  const movie = { title: "  A  Movie ", genre: " Drama\nfilm ", plot: " First  scene.\nSecond scene. ", source_url: "https://example.invalid/private" };
  assert.equal(buildMovieEmbeddingInput(movie), "Title: A Movie\nGenre: Drama film\nPlot: First scene. Second scene.");
  assert.equal(buildMovieEmbeddingInput({ title: "A Movie", genre: "Drama film", plot: "First scene. Second scene." }), buildMovieEmbeddingInput(movie));
  assert.equal(buildEmbeddingInput({ title: "Series", description: "A description." }), "Title: Series\nPlot: A description.");
  const text = buildMovieEmbeddingInput(movie);
  assert.equal(embeddingContentHash(text, model), embeddingContentHash(text, model));
  assert.notEqual(embeddingContentHash(text, model), embeddingContentHash(text + " More", model));
  assert.notEqual(embeddingContentHash(text, model), embeddingContentHash(text, "text-embedding-3-large"));
});

test("empty inputs and request bounds are rejected before calling the API", async () => {
  let calls = 0;
  const client = { embeddings: { create: async () => { calls += 1; return response([[0, vector()]]); } } };
  await assert.rejects(embedTexts([], { client, model }), /at least one/u);
  await assert.rejects(embedText("  ", { client, model }), /nonempty/u);
  await assert.rejects(embedTexts(["x".repeat(8193)], { client, model }), /not truncated/u);
  await assert.rejects(embedTexts(Array(2049).fill("x"), { client, model }), /2048/u);
  assert.throws(() => buildMovieEmbeddingInput({ title: "", plot: "A plot" }), /title/u);
  assert.equal(calls, 0);
});

test("invalid vector dimensions and nonfinite values are rejected", async () => {
  for (const embedding of [vector().slice(1), [...vector().slice(1), NaN], [...vector().slice(1), Infinity]]) {
    const client = { embeddings: { create: async () => response([[0, embedding]]) } };
    await assert.rejects(embedText("A valid description", { client, model }), /invalid dimensions or numeric values/u);
  }
});

test("batch response indices restore input order and report actual usage", async () => {
  let calls = 0;
  const client = { embeddings: { create: async (request) => {
    calls += 1;
    assert.deepEqual(request.input, ["First", "Second"]);
    assert.equal(request.dimensions, EMBEDDING_DIMENSIONS);
    return response([[1, vector(2)], [0, vector(1)]], 15);
  } } };
  const result = await embedTexts(["First", "Second"], { client, model });
  assert.equal(calls, 1);
  assert.equal(result.inputTokens, 15);
  assert.equal(result.embeddings[0][0], 1);
  assert.equal(result.embeddings[1][0], 2);
});

test("missing or duplicate response indices are rejected", async () => {
  const client = { embeddings: { create: async () => response([[0, vector()], [0, vector()]]) } };
  await assert.rejects(embedTexts(["First", "Second"], { client, model }), /indices/u);
});

test("malformed API response and usage are rejected", async () => {
  for (const bad of [
    { ...response([[0, vector()]]), object: "other" },
    { ...response([[0, vector()]]), usage: { prompt_tokens: 0, total_tokens: 0 } },
  ]) {
    const client = { embeddings: { create: async () => bad } };
    await assert.rejects(embedText("A valid description", { client, model }), /invalid/u);
  }
});

test("transient server errors retry with bounded exponential delays", async () => {
  let calls = 0;
  const delays = [];
  const client = { embeddings: { create: async () => {
    calls += 1;
    if (calls < 3) throw { status: 503 };
    return response([[0, vector()]]);
  } } };
  const result = await embedText("A valid description", { client, model, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(result.embedding.length, EMBEDDING_DIMENSIONS);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});

test("rate limits and timeouts retry, then preserve valid results", async () => {
  for (const failure of [{ status: 429, code: "rate_limit_exceeded" }, new OpenAI.APIConnectionTimeoutError()]) {
    let calls = 0;
    const client = { embeddings: { create: async () => {
      calls += 1;
      if (calls === 1) throw failure;
      return response([[0, vector()]]);
    } } };
    const result = await embedText("A valid description", { client, model, sleep: async () => {} });
    assert.equal(result.embedding.length, EMBEDDING_DIMENSIONS);
    assert.equal(calls, 2);
  }
});

test("authentication and quota failures are permanent", async () => {
  for (const [failure, message] of [
    [{ status: 401 }, /authentication/u],
    [{ status: 429, code: "insufficient_quota" }, /quota or billing/u],
  ]) {
    let calls = 0;
    const client = { embeddings: { create: async () => { calls += 1; throw failure; } } };
    await assert.rejects(embedText("A valid description", { client, model, sleep: async () => { throw new Error("should not retry"); } }), message);
    assert.equal(calls, 1);
  }
});

test("persistent transient errors stop after three attempts", async () => {
  let calls = 0;
  const client = { embeddings: { create: async () => { calls += 1; throw { status: 503 }; } } };
  await assert.rejects(embedText("A valid description", { client, model, sleep: async () => {} }), /HTTP 503/u);
  assert.equal(calls, 3);
});

test("missing API key fails without initializing an OpenAI client", () => {
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    assert.throws(() => getOpenAIClient(), /OPENAI_API_KEY is missing/u);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("invalid model configuration fails before any API request", () => {
  const previous = process.env.OPENAI_EMBEDDING_MODEL;
  process.env.OPENAI_EMBEDDING_MODEL = "";
  try {
    assert.throws(() => getEmbeddingModel(), /OPENAI_EMBEDDING_MODEL/u);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_EMBEDDING_MODEL;
    else process.env.OPENAI_EMBEDDING_MODEL = previous;
  }
});
