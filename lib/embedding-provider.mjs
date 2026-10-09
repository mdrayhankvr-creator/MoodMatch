import { createHash } from "node:crypto";
import {
  EMBEDDING_DIMENSIONS as OPENAI_DIMENSIONS,
  embedTexts as embedOpenAITexts,
  getEmbeddingModel,
} from "./embedding-runtime.mjs";

export const LOCAL_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const LOCAL_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const LOCAL_DIMENSIONS = 384;
export const LOCAL_MAX_TOKENS = 256;

let cachedProvider;

export class LocalInputTooLongError extends Error {
  constructor(index, tokenCount) {
    super(`Local input ${index} has ${tokenCount} tokens (limit ${LOCAL_MAX_TOKENS}); chunking is required. No text was truncated.`);
    this.name = "LocalInputTooLongError";
    this.index = index;
    this.tokenCount = tokenCount;
  }
}

export function getEmbeddingProviderId(env = process.env) {
  const configured = env.EMBEDDING_PROVIDER;
  const id = configured === undefined ? "local" : configured.trim();
  if (id !== "local" && id !== "openai") {
    throw new Error("EMBEDDING_PROVIDER must be local or openai.");
  }
  return id;
}

export function getLocalModelId(env = process.env) {
  const configured = env.LOCAL_EMBEDDING_MODEL;
  const id = configured === undefined ? LOCAL_MODEL_ID : configured.trim();
  if (id !== LOCAL_MODEL_ID) {
    throw new Error(`LOCAL_EMBEDDING_MODEL must be ${LOCAL_MODEL_ID} in this milestone.`);
  }
  return id;
}

export function providerContentHash(text, providerId = getEmbeddingProviderId(), modelId) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Embedding text must be nonempty.");
  if (providerId !== "local" && providerId !== "openai") throw new Error("Invalid embedding provider.");
  const selectedModel = modelId ?? (providerId === "local" ? getLocalModelId() : getEmbeddingModel());
  return createHash("sha256").update(`embedding-v2\0${providerId}\0${selectedModel}\0${text}`).digest("hex");
}

export function validateEmbeddingVectors(vectors, count, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== count) {
    throw new Error("Embedding provider returned an incorrect number of vectors.");
  }
  for (const [index, vector] of vectors.entries()) {
    if (!Array.isArray(vector) || vector.length !== dimensions ||
        !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error(`Embedding provider returned invalid values or dimensions at index ${index}.`);
    }
  }
  return vectors;
}

function validateTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0 ||
      texts.some((text) => typeof text !== "string" || !text.trim())) {
    throw new Error("Provide a nonempty array of nonempty embedding texts.");
  }
}

async function defaultLoadLocalModel(modelId) {
  const { pipeline } = await import("@huggingface/transformers");
  return pipeline("feature-extraction", modelId, { device: "cpu", revision: LOCAL_MODEL_REVISION });
}

/** @param {{providerId?: "local"|"openai", localModelId?: string,
 * loadLocalModel?: (modelId: string) => Promise<unknown>,
 * embedOpenAI?: (texts: string[]) => Promise<{embeddings: number[][], inputTokens: number}>}} [options]
 */
export function createEmbeddingProvider(options = {}) {
  const id = options.providerId ?? getEmbeddingProviderId();
  if (id === "openai") {
    const modelId = getEmbeddingModel();
    const embedOpenAI = options.embedOpenAI ?? embedOpenAITexts;
    return {
      id, modelId, dimensions: OPENAI_DIMENSIONS,
      async embedBatch(texts) {
        validateTexts(texts);
        const result = await embedOpenAI(texts);
        const embeddings = validateEmbeddingVectors(result.embeddings, texts.length, OPENAI_DIMENSIONS);
        return { embeddings, providerId: id, modelId, model: modelId, dimensions: OPENAI_DIMENSIONS, inputTokens: result.inputTokens };
      },
      async embedText(text) {
        const result = await this.embedBatch([text]);
        return { embedding: result.embeddings[0], providerId: id, modelId, model: modelId, dimensions: OPENAI_DIMENSIONS, inputTokens: result.inputTokens };
      },
    };
  }
  if (id !== "local") throw new Error("EMBEDDING_PROVIDER must be local or openai.");
  const modelId = options.localModelId ?? getLocalModelId();
  if (modelId !== LOCAL_MODEL_ID) throw new Error(`Unsupported local model: ${modelId}.`);
  const loadLocalModel = options.loadLocalModel ?? defaultLoadLocalModel;
  let modelPromise;

  async function getModel() {
    if (!modelPromise) {
      modelPromise = Promise.resolve().then(() => loadLocalModel(modelId)).catch((error) => {
        modelPromise = undefined;
        throw error;
      });
    }
    return modelPromise;
  }

  async function tokenCounts(texts) {
    validateTexts(texts);
    const model = await getModel();
    if (typeof model.tokenizer !== "function") throw new Error("Local model tokenizer is unavailable.");
    return texts.map((text) => {
      const encoded = model.tokenizer(text, { truncation: false, padding: false, return_tensor: false });
      const ids = encoded?.input_ids;
      if (!Array.isArray(ids) || !ids.every((token) => Number.isInteger(token))) {
        throw new Error("Local tokenizer returned invalid token IDs.");
      }
      return ids.length;
    });
  }

  return {
    id, modelId, modelRevision: LOCAL_MODEL_REVISION, dimensions: LOCAL_DIMENSIONS,
    tokenCounts,
    async embedBatch(texts) {
      const counts = await tokenCounts(texts);
      const overLimit = counts.findIndex((count) => count > LOCAL_MAX_TOKENS);
      if (overLimit >= 0) throw new LocalInputTooLongError(overLimit, counts[overLimit]);
      const model = await getModel();
      const tensor = await model(texts, { pooling: "mean", normalize: true });
      const embeddings = validateEmbeddingVectors(tensor?.tolist?.(), texts.length, LOCAL_DIMENSIONS);
      return { embeddings, providerId: id, modelId, dimensions: LOCAL_DIMENSIONS };
    },
    async embedText(text) {
      const result = await this.embedBatch([text]);
      return { embedding: result.embeddings[0], providerId: id, modelId, dimensions: LOCAL_DIMENSIONS };
    },
  };
}

export function getEmbeddingProvider() {
  const id = getEmbeddingProviderId();
  const modelId = id === "local" ? getLocalModelId() : getEmbeddingModel();
  const key = `${id}\0${modelId}`;
  if (cachedProvider?.key !== key) {
    cachedProvider = { key, provider: createEmbeddingProvider({ providerId: id, localModelId: id === "local" ? modelId : undefined }) };
  }
  return cachedProvider.provider;
}
