import "server-only";
import type { Collection } from "@datastax/astra-db-ts";
import { getAstraDb } from "./astra";
import {
  initializeMovieCollection, makeMovieVectorDocument, searchMovieVectors,
  upsertMovieVector, verifyMovieVector,
} from "./movie-vector-store.mjs";

export interface MovieRecord {
  id: string;
  title: string;
  year: string;
  genre: string;
  plot: string;
  source_url: string;
}

export interface LocalMovieEmbedding {
  id: string;
  vector: number[];
  sourceHash: string;
  chunkCount: number;
}

export interface MovieVectorDocument {
  _id: string;
  content_type: "movie";
  title: string;
  year: number | null;
  genre: string;
  plot: string;
  source_url: string;
  content_hash: string;
  embedding_provider: "local";
  embedding_model: string;
  model_revision: string;
  embedding_version: string;
  chunk_count: number;
  $vector: number[];
}

export async function initializeLocalMovieCollection(apply = false): Promise<{
  collection: Collection<MovieVectorDocument> | null;
  state: "created" | "reused" | "missing";
}> {
  return initializeMovieCollection(getAstraDb(), { apply }) as Promise<{
    collection: Collection<MovieVectorDocument> | null;
    state: "created" | "reused" | "missing";
  }>;
}

export function buildMovieVectorDocument(movie: MovieRecord, embedding: LocalMovieEmbedding): MovieVectorDocument {
  return makeMovieVectorDocument(movie, embedding) as MovieVectorDocument;
}

export async function upsertLocalMovie(collection: Collection<MovieVectorDocument>, document: MovieVectorDocument): Promise<"inserted" | "updated" | "metadata-updated" | "unchanged"> {
  return upsertMovieVector(collection, document) as Promise<"inserted" | "updated" | "metadata-updated" | "unchanged">;
}

export async function verifyLocalMovie(collection: Collection<MovieVectorDocument>, document: MovieVectorDocument): Promise<boolean> {
  return verifyMovieVector(collection, document);
}

export async function findSimilarLocalMovies(collection: Collection<MovieVectorDocument>, sampleId: string, limit = 5): Promise<Array<{
  id: string;
  title: string;
  similarity: number;
}>> {
  return searchMovieVectors(collection, sampleId, limit);
}
