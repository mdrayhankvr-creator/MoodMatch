import "server-only";

import {
  buildEmbeddingInput as runtimeBuildInput,
  buildMovieEmbeddingInput as runtimeBuildMovieInput,
  embedText as runtimeEmbedText,
  embedTexts as runtimeEmbedTexts,
  embeddingContentHash as runtimeContentHash,
  tokenUpperBound as runtimeTokenUpperBound,
} from "./embedding-runtime.mjs";

export type EmbeddingBatch = { embeddings: number[][]; inputTokens: number; model: string };
export type SingleEmbedding = { embedding: number[]; inputTokens: number; model: string };
export type DescriptionInput = { title: string; genre?: string; description: string };
export type MovieInput = { title: string; genre?: string; plot: string };

export function buildEmbeddingInput(input: DescriptionInput): string {
  return runtimeBuildInput(input);
}

export function buildMovieEmbeddingInput(movie: MovieInput): string {
  return runtimeBuildMovieInput(movie);
}

export function embeddingContentHash(text: string, model?: string): string {
  return runtimeContentHash(text, model);
}

export function tokenUpperBound(text: string): number {
  return runtimeTokenUpperBound(text);
}

export async function embedTexts(texts: string[]): Promise<EmbeddingBatch> {
  return runtimeEmbedTexts(texts);
}

export async function embedText(text: string): Promise<SingleEmbedding> {
  return runtimeEmbedText(text);
}
