import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LOCAL_DIMENSIONS, LOCAL_MAX_TOKENS, LOCAL_MODEL_ID, LocalInputTooLongError,
  createEmbeddingProvider, getEmbeddingProviderId, getLocalModelId,
  providerContentHash, validateEmbeddingVectors,
} from "../lib/embedding-provider.mjs";

const localVector = (value = 0.1) => Array(LOCAL_DIMENSIONS).fill(value);

function mockModel({ tokenCount = () => 12, onInfer = () => {} } = {}) {
  const model = async (texts, options) => {
    onInfer(texts, options);
    return { tolist: () => texts.map((text) => localVector(text === "Second" ? 2 : 1)) };
  };
  model.tokenizer = (text, options) => {
    assert.equal(options.truncation, false);
    return { input_ids: Array(tokenCount(text)).fill(1) };
  };
  return model;
}

test("local is the default provider and does not need an OpenAI key", async () => {
  assert.equal(getEmbeddingProviderId({}), "local");
  assert.equal(getLocalModelId({}), LOCAL_MODEL_ID);
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  let openAiCalls = 0;
  try {
    const provider = createEmbeddingProvider({
      providerId: "local",
      loadLocalModel: async () => mockModel(),
      embedOpenAI: async () => { openAiCalls += 1; throw new Error("OpenAI was called"); },
    });
    const result = await provider.embedText("A real description is supplied by callers.");
    assert.equal(provider.id, "local");
    assert.equal(result.embedding.length, LOCAL_DIMENSIONS);
    assert.equal(openAiCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("provider and local model settings are validated", () => {
  assert.equal(getEmbeddingProviderId({ EMBEDDING_PROVIDER: "openai" }), "openai");
  assert.throws(() => getEmbeddingProviderId({ EMBEDDING_PROVIDER: "" }), /must be local or openai/u);
  assert.throws(() => getLocalModelId({ LOCAL_EMBEDDING_MODEL: "unverified/model" }), /must be/u);
});

test("local batch preserves input order and validates normalized vectors", async () => {
  let received;
  const provider = createEmbeddingProvider({
    providerId: "local",
    loadLocalModel: async () => mockModel({ onInfer: (texts, options) => { received = { texts, options }; } }),
  });
  const result = await provider.embedBatch(["Second", "First"]);
  assert.deepEqual(received.texts, ["Second", "First"]);
  assert.deepEqual(received.options, { pooling: "mean", normalize: true });
  assert.equal(result.embeddings[0][0], 2);
  assert.equal(result.embeddings[1][0], 1);
  assert.equal(result.dimensions, 384);
  assert.equal(result.modelId, LOCAL_MODEL_ID);
});

test("local model initialization is reused across calls", async () => {
  let loads = 0;
  const provider = createEmbeddingProvider({
    providerId: "local",
    loadLocalModel: async () => { loads += 1; return mockModel(); },
  });
  await provider.embedText("First");
  await provider.embedText("Second");
  assert.equal(loads, 1);
});

test("over-limit local input is rejected before inference without truncation", async () => {
  let inferenceCalls = 0;
  const provider = createEmbeddingProvider({
    providerId: "local",
    loadLocalModel: async () => mockModel({
      tokenCount: (text) => text === "long" ? LOCAL_MAX_TOKENS + 1 : 12,
      onInfer: () => { inferenceCalls += 1; },
    }),
  });
  await assert.rejects(provider.embedBatch(["short", "long"]), (error) => {
    assert.ok(error instanceof LocalInputTooLongError);
    assert.equal(error.index, 1);
    assert.equal(error.tokenCount, 257);
    return true;
  });
  assert.equal(inferenceCalls, 0);
});

test("empty and malformed inputs fail before local model loading", async () => {
  let loads = 0;
  const provider = createEmbeddingProvider({
    providerId: "local",
    loadLocalModel: async () => { loads += 1; return mockModel(); },
  });
  await assert.rejects(provider.embedBatch([]), /nonempty/u);
  await assert.rejects(provider.embedText("  "), /nonempty/u);
  assert.equal(loads, 0);
});

test("invalid dimensions and numeric values fail centrally", () => {
  for (const bad of [localVector().slice(1), [...localVector().slice(1), NaN], [...localVector().slice(1), Infinity]]) {
    assert.throws(() => validateEmbeddingVectors([bad], 1, LOCAL_DIMENSIONS), /invalid values or dimensions/u);
  }
  assert.throws(() => validateEmbeddingVectors([], 1, LOCAL_DIMENSIONS), /incorrect number/u);
});

test("OpenAI fallback keeps its 1536-dimensional contract", async () => {
  let calls = 0;
  const provider = createEmbeddingProvider({
    providerId: "openai",
    embedOpenAI: async (texts) => { calls += 1; return { embeddings: texts.map(() => Array(1536).fill(0.2)), inputTokens: 14 }; },
  });
  const result = await provider.embedBatch(["First", "Second"]);
  assert.equal(calls, 1);
  assert.equal(result.providerId, "openai");
  assert.equal(result.model, result.modelId);
  assert.equal(result.dimensions, 1536);
  assert.equal(result.inputTokens, 14);
});

test("content hashes are stable and separate provider spaces", () => {
  const text = "Title: A movie\nPlot: A real description";
  assert.equal(providerContentHash(text, "local", LOCAL_MODEL_ID), providerContentHash(text, "local", LOCAL_MODEL_ID));
  assert.notEqual(providerContentHash(text, "local", LOCAL_MODEL_ID), providerContentHash(text, "openai", "text-embedding-3-small"));
  assert.notEqual(providerContentHash(text, "local", LOCAL_MODEL_ID), providerContentHash(text + "!", "local", LOCAL_MODEL_ID));
});
