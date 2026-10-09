import { createHash } from "node:crypto";
import OpenAI from "openai";

export const EMBEDDING_DIMENSIONS = 1536;
export const MAX_INPUT_TOKENS = 8192;
export const MAX_BATCH_INPUTS = 2048;
export const MAX_REQUEST_TOKENS = 300000;
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20000;

let cachedClient;

export function getEmbeddingModel() {
  const configured = process.env.OPENAI_EMBEDDING_MODEL;
  const model = configured === undefined ? "text-embedding-3-small" : configured.trim();
  if (model !== "text-embedding-3-small" && model !== "text-embedding-3-large") {
    throw new Error("OPENAI_EMBEDDING_MODEL must be text-embedding-3-small or text-embedding-3-large.");
  }
  return model;
}

export function getOpenAIClient() {
  if (cachedClient) return cachedClient;
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || apiKey.length < 20 || /\s/u.test(apiKey) || /^(?:your|replace|placeholder|example|dummy|test)[_ -]/iu.test(apiKey)) {
    throw new Error("OPENAI_API_KEY is missing or contains a placeholder.");
  }
  cachedClient = new OpenAI({ apiKey, maxRetries: 0, timeout: REQUEST_TIMEOUT_MS });
  return cachedClient;
}

function clean(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

/** @param {{title: string, genre?: string, description: string}} input */
export function buildEmbeddingInput({ title, genre, description }) {
  const name = clean(title);
  const plot = clean(description);
  if (!name || !plot) throw new Error("An embedding description needs a title and nonempty description.");
  const category = clean(genre);
  return [`Title: ${name}`, ...(category ? [`Genre: ${category}`] : []), `Plot: ${plot}`].join("\n");
}

/** @param {{title: string, genre?: string, plot: string}} movie */
export function buildMovieEmbeddingInput({ title, genre, plot }) {
  return buildEmbeddingInput({ title, genre, description: plot });
}

export function embeddingContentHash(text, model = getEmbeddingModel()) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Embedding text must be nonempty.");
  if (model !== "text-embedding-3-small" && model !== "text-embedding-3-large") {
    throw new Error("Unsupported embedding model.");
  }
  return createHash("sha256").update(`embedding-v1\0${model}\0${text}`).digest("hex");
}

// A tokenizer can use at most one token per UTF-8 byte. This conservative bound
// prevents over-limit API requests without truncating text or adding a tokenizer dependency.
export function tokenUpperBound(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("Embedding text must be nonempty.");
  return Buffer.byteLength(text, "utf8");
}

function validateInputs(texts) {
  if (!Array.isArray(texts) || texts.length === 0) throw new Error("Provide at least one embedding text.");
  if (texts.length > MAX_BATCH_INPUTS) throw new Error(`A batch may contain at most ${MAX_BATCH_INPUTS} inputs.`);
  let upperBound = 0;
  for (const [index, text] of texts.entries()) {
    const bytes = tokenUpperBound(text);
    if (bytes > MAX_INPUT_TOKENS) throw new Error(`Input ${index} exceeds the conservative ${MAX_INPUT_TOKENS}-token safety bound; it was not truncated.`);
    upperBound += bytes;
  }
  if (upperBound > MAX_REQUEST_TOKENS) {
    throw new Error(`Batch exceeds the conservative ${MAX_REQUEST_TOKENS}-token request bound.`);
  }
  return upperBound;
}

function errorCode(error) {
  return String(error?.code ?? error?.error?.code ?? "").toLowerCase();
}

function isQuotaError(error) {
  return /(?:quota|billing|balance|credit)/u.test(errorCode(error));
}

function isTransient(error) {
  if (isQuotaError(error)) return false;
  const status = error?.status;
  if (status === 408 || status === 409 || status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599)) return true;
  return error instanceof OpenAI.APIConnectionError || error instanceof OpenAI.APIConnectionTimeoutError;
}

function safeError(error) {
  if (error?.status === 401) return new Error("OpenAI authentication failed. Check OPENAI_API_KEY.");
  if (error?.status === 403) return new Error("OpenAI API access is denied for this project.");
  if (isQuotaError(error)) return new Error("OpenAI API quota or billing limit was reached.");
  if (error?.status === 429) return new Error("OpenAI rate limit persisted after bounded retries.");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new Error("OpenAI request timed out after bounded retries.");
  if (error instanceof OpenAI.APIConnectionError) return new Error("OpenAI network connection failed after bounded retries.");
  if (Number.isInteger(error?.status)) return new Error(`OpenAI embedding request failed (HTTP ${error.status}).`);
  return new Error("OpenAI embedding request failed.");
}

function validateResponse(response, count, model) {
  if (response?.object !== "list" || response.model !== model || !Array.isArray(response.data) || response.data.length !== count) {
    throw new Error("OpenAI returned an invalid embedding response.");
  }
  const embeddings = new Array(count);
  for (const item of response.data) {
    if (item?.object !== "embedding" || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || embeddings[item.index]) {
      throw new Error("OpenAI returned missing or duplicate embedding indices.");
    }
    if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIMENSIONS ||
        !item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new Error("OpenAI returned an embedding with invalid dimensions or numeric values.");
    }
    embeddings[item.index] = item.embedding;
  }
  if (embeddings.some((item) => !item)) throw new Error("OpenAI returned incomplete embeddings.");
  const tokens = response.usage?.prompt_tokens;
  const total = response.usage?.total_tokens;
  if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(total) || total < tokens) {
    throw new Error("OpenAI returned invalid token usage.");
  }
  return { embeddings, inputTokens: tokens, model };
}

/** @param {string[]} texts
 *  @param {{client?: Pick<OpenAI, "embeddings">, model?: string, sleep?: (ms: number) => Promise<void>}} [options]
 */
export async function embedTexts(texts, options = {}) {
  validateInputs(texts);
  const model = options.model ?? getEmbeddingModel();
  if (model !== "text-embedding-3-small" && model !== "text-embedding-3-large") throw new Error("Unsupported embedding model.");
  const client = options.client ?? getOpenAIClient();
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let response;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      response = await client.embeddings.create({
        model,
        input: texts,
        dimensions: EMBEDDING_DIMENSIONS,
        encoding_format: "float",
      });
      break;
    } catch (error) {
      if (!isTransient(error) || attempt === MAX_ATTEMPTS) throw safeError(error);
      await sleep(Math.min(250 * 2 ** (attempt - 1), 1000));
    }
  }
  return validateResponse(response, texts.length, model);
}

export async function embedText(text, options = {}) {
  const result = await embedTexts([text], options);
  return { embedding: result.embeddings[0], inputTokens: result.inputTokens, model: result.model };
}
