import "server-only";

import type OpenAI from "openai";
import { getEmbeddingModel as runtimeModel, getOpenAIClient as runtimeClient } from "./embedding-runtime.mjs";

export type EmbeddingModel = "text-embedding-3-small" | "text-embedding-3-large";

export function getEmbeddingModel(): EmbeddingModel {
  return runtimeModel();
}

export function getOpenAIClient(): OpenAI {
  return runtimeClient();
}
