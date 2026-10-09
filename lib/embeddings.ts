import "server-only";

import {
  buildEmbeddingInput as runtimeBuildInput,
  buildMovieEmbeddingInput as runtimeBuildMovieInput,
  tokenUpperBound as runtimeTokenUpperBound,
} from "./embedding-runtime.mjs";
import {
  getEmbeddingProvider as runtimeProvider,
  providerContentHash as runtimeContentHash,
} from "./embedding-provider.mjs";

export type ProviderId = "local" | "openai";
export type EmbeddingBatch = {
  embeddings: number[][];
  providerId: ProviderId;
  modelId: string;
  model?: string;
  dimensions: number;
  inputTokens?: number;
};
export type SingleEmbedding = {
  embedding: number[];
  providerId: ProviderId;
  modelId: string;
  model?: string;
  dimensions: number;
  inputTokens?: number;
};
export type EmbeddingProvider = {
  id: ProviderId;
  modelId: string;
  dimensions: number;
  embedText(text: string): Promise<SingleEmbedding>;
  embedBatch(texts: string[]): Promise<EmbeddingBatch>;
  tokenCounts?: (texts: string[]) => Promise<number[]>;
};
export type DescriptionInput = { title: string; genre?: string; description: string };
export type MovieInput = { title: string; genre?: string; plot: string };

export function buildEmbeddingInput(input: DescriptionInput): string {
  return runtimeBuildInput(input);
}

export function buildMovieEmbeddingInput(movie: MovieInput): string {
  return runtimeBuildMovieInput(movie);
}

export function embeddingContentHash(text: string, model?: string): string {
  const provider = getEmbeddingProvider();
  return runtimeContentHash(text, provider.id, model ?? provider.modelId);
}

export function tokenUpperBound(text: string): number {
  return runtimeTokenUpperBound(text);
}

export function getEmbeddingProvider(): EmbeddingProvider {
  return runtimeProvider() as EmbeddingProvider;
}

export async function embedBatch(texts: string[]): Promise<EmbeddingBatch> {
  return getEmbeddingProvider().embedBatch(texts);
}

export async function embedTexts(texts: string[]): Promise<EmbeddingBatch> {
  return embedBatch(texts);
}

export async function embedText(text: string): Promise<SingleEmbedding> {
  return getEmbeddingProvider().embedText(text);
}
