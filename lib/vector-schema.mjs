import { Buffer } from "node:buffer";
import { DEFAULT_CHUNK_CONFIG } from "./chunking.mjs";
import { makeCacheIdentity } from "./embedding-cache.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION,
  validateEmbeddingVectors } from "./embedding-provider.mjs";
import { buildMovieEmbeddingInput } from "./embedding-runtime.mjs";
import { validateFullDataset } from "./full-ingestion-readiness.mjs";
import { EMBEDDING_VERSION, LOCAL_COLLECTION, makeMovieVectorDocument,
  validateMovieRecord } from "./movie-vector-store.mjs";

export const V2_COLLECTION = "movies_local_384_v2";
export const V2_INDEXED_METADATA_FIELDS = Object.freeze([
  "content_type", "genre", "year", "title", "embedding_provider",
]);
// $vector is a separate vector index, not a metadata string index.
export const V2_INDEXED_FIELDS = Object.freeze(["$vector", ...V2_INDEXED_METADATA_FIELDS]);
export const V2_COLLECTION_DEFINITION = Object.freeze({
  vector: Object.freeze({ dimension: LOCAL_DIMENSIONS, metric: "cosine" }),
  indexing: Object.freeze({ allow: V2_INDEXED_FIELDS }),
});

// Astra documents 4 million *characters* per document. A 4 million UTF-8 byte
// ceiling is deliberately stricter and makes our local size check deterministic.
export const V2_DOCUMENT_BYTE_CEILING = 4_000_000;
export const V2_INDEXED_STRING_BYTE_CEILING = 8_000;
const VECTOR_COMPONENT_BUDGET_BYTES = 33; // number text plus comma; conservative for unit vectors

export function resolveLocalVectorCollection(configured = process.env.MOVIE_VECTOR_COLLECTION) {
  const name = configured ?? LOCAL_COLLECTION;
  if (name !== LOCAL_COLLECTION && name !== V2_COLLECTION) {
    throw new Error("Unsupported local vector collection; OpenAI and unknown namespaces are forbidden.");
  }
  return name;
}

export function validateV2CollectionDescriptor(descriptor) {
  const definition = descriptor?.definition;
  const vector = definition?.vector;
  const indexing = definition?.indexing;
  const allowedDefinitionKeys = ["vector", "indexing", "defaultId", "lexical", "rerank"];
  // Astra currently reports these server defaults even when createCollection
  // supplies only vector and indexing. They do not enable vectorization.
  const lexical = definition?.lexical;
  const rerank = definition?.rerank;
  const knownLexicalDefault = lexical == null ||
    (lexical.enabled === true && lexical.analyzer === "standard" &&
      Object.keys(lexical).length === 2);
  const knownRerankDefault = rerank == null ||
    (rerank.enabled === true && Object.keys(rerank).length === 2 &&
      rerank.service?.provider === "nvidia" &&
      rerank.service?.modelName === "nvidia/llama-3.2-nv-rerankqa-1b-v2" &&
      Object.keys(rerank.service).length === 2);
  if (descriptor?.name !== V2_COLLECTION || !definition ||
      Object.keys(definition).some((key) => !allowedDefinitionKeys.includes(key)) ||
      definition.defaultId != null || !knownLexicalDefault || !knownRerankDefault || !vector ||
      Object.keys(vector).some((key) => !["dimension", "metric", "sourceModel", "service"].includes(key)) ||
      vector.dimension !== LOCAL_DIMENSIONS || vector.metric !== "cosine" ||
      vector.service != null || (vector.sourceModel != null && vector.sourceModel !== "other") ||
      !indexing || Object.keys(indexing).some((key) => key !== "allow") ||
      !Array.isArray(indexing.allow) ||
      indexing.allow.length !== V2_INDEXED_FIELDS.length ||
      new Set(indexing.allow).size !== V2_INDEXED_FIELDS.length ||
      indexing.allow.some((field) => !V2_INDEXED_FIELDS.includes(field))) {
    throw new Error("Existing v2 collection has an incompatible vector or indexing configuration.");
  }
  return true;
}

/** Read-only inspection. This module exposes no collection creation or mutation. */
export async function inspectV2Collection(db) {
  const descriptor = (await db.listCollections()).find((item) => item.name === V2_COLLECTION);
  if (!descriptor) return { state: "missing", collection: null };
  validateV2CollectionDescriptor(descriptor);
  return { state: "compatible", collection: db.collection(V2_COLLECTION) };
}

export function v2MetadataFilter(field, value) {
  if (!V2_INDEXED_METADATA_FIELDS.includes(field)) {
    throw new Error("V2 filter field is not indexed.");
  }
  if (field === "year" ? !(value === null || Number.isSafeInteger(value))
    : typeof value !== "string") {
    throw new Error("Invalid v2 metadata filter value.");
  }
  return { [field]: value };
}

export function v2IdFilter(id) {
  if (typeof id !== "string" || !/^(?:movie|series)_[a-f0-9]{20,64}$/u.test(id)) {
    throw new Error("Invalid stable v2 document ID.");
  }
  return { _id: id };
}

function movieMetadata(movie) {
  validateMovieRecord(movie);
  const identity = makeCacheIdentity({ recordId: movie.id,
    normalizedText: buildMovieEmbeddingInput(movie), providerId: "local",
    modelId: LOCAL_MODEL_ID, modelRevision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, chunkConfig: DEFAULT_CHUNK_CONFIG });
  return {
    _id: movie.id, content_type: "movie", title: movie.title,
    year: movie.year === "" ? null : Number(movie.year), genre: movie.genre,
    plot: movie.plot, source_url: movie.source_url, content_hash: identity.sourceHash,
    embedding_provider: "local", embedding_model: LOCAL_MODEL_ID,
    model_revision: LOCAL_MODEL_REVISION, embedding_version: EMBEDDING_VERSION,
  };
}

function validateStoredFields(document, movie) {
  const expected = movieMetadata(movie);
  for (const [field, value] of Object.entries(expected)) {
    if (document?.[field] !== value) throw new Error(`V2 document ${field} differs from source movie or local provenance.`);
  }
  for (const field of V2_INDEXED_METADATA_FIELDS) {
    const value = document[field];
    if (typeof value === "string" && Buffer.byteLength(value, "utf8") > V2_INDEXED_STRING_BYTE_CEILING) {
      throw new Error(`V2 indexed field ${field} exceeds 8,000 UTF-8 bytes.`);
    }
  }
  return expected;
}

export function validateV2MovieDocument(document, movie) {
  validateStoredFields(document, movie);
  const expectedKeys = [...Object.keys(movieMetadata(movie)), "chunk_count", "$vector"];
  if (Object.keys(document).length !== expectedKeys.length ||
      Object.keys(document).some((key) => !expectedKeys.includes(key)) ||
      !Number.isSafeInteger(document.chunk_count) || document.chunk_count < 1) {
    throw new Error("V2 movie document fields or chunk count are invalid.");
  }
  validateEmbeddingVectors([document.$vector], 1, LOCAL_DIMENSIONS);
  const norm = Math.hypot(...document.$vector);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new Error("V2 movie vector must have unit L2 norm.");
  }
  const json = JSON.stringify(document);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > V2_DOCUMENT_BYTE_CEILING || json.length > 4_000_000) {
    throw new Error("V2 document exceeds the conservative byte or documented character limit.");
  }
  return { documentBytes: bytes, plotBytes: Buffer.byteLength(document.plot, "utf8") };
}

export function makeV2MovieDocument(movie, embedding) {
  // The legacy builder enforces source, revision, chunk, checksum, and vector provenance.
  const document = makeMovieVectorDocument(movie, embedding);
  validateV2MovieDocument(document, movie);
  return document;
}

/** Offline upper bound: complete metadata plus 33 serialized bytes per vector component. */
export function estimateV2MovieDocument(movie) {
  const metadata = movieMetadata(movie);
  validateStoredFields(metadata, movie);
  const emptyVectorDocument = { ...metadata, chunk_count: 1, $vector: [] };
  const estimatedDocumentBytes = Buffer.byteLength(JSON.stringify(emptyVectorDocument), "utf8") +
    LOCAL_DIMENSIONS * VECTOR_COMPONENT_BUDGET_BYTES;
  if (estimatedDocumentBytes > V2_DOCUMENT_BYTE_CEILING) {
    throw new Error("Estimated v2 document exceeds the conservative byte limit.");
  }
  return { id: movie.id, plotBytes: Buffer.byteLength(movie.plot, "utf8"),
    estimatedDocumentBytes };
}

export function assessV2MovieDataset(movies, expectedCount = 1100) {
  validateFullDataset(movies, expectedCount);
  const violations = [];
  let maxPlotBytes = 0;
  let maxEstimatedDocumentBytes = 0;
  let oversizedLegacyPlots = 0;
  for (const movie of movies) {
    try {
      const size = estimateV2MovieDocument(movie);
      maxPlotBytes = Math.max(maxPlotBytes, size.plotBytes);
      maxEstimatedDocumentBytes = Math.max(maxEstimatedDocumentBytes, size.estimatedDocumentBytes);
      if (size.plotBytes > V2_INDEXED_STRING_BYTE_CEILING) oversizedLegacyPlots += 1;
    } catch (error) {
      violations.push({ id: movie.id, reason: error.message });
    }
  }
  return { records: movies.length, representable: movies.length - violations.length,
    violations, oversizedLegacyPlots, maxPlotBytes, maxEstimatedDocumentBytes,
    emptyGenre: movies.filter((movie) => movie.genre === "").length };
}
