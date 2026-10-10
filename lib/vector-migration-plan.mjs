import { createHash } from "node:crypto";
import { DataAPIVector } from "@datastax/astra-db-ts";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION,
  validateEmbeddingVectors } from "./embedding-provider.mjs";
import { validateFullDataset } from "./full-ingestion-readiness.mjs";
import { inspectMovieCache } from "./movie-embeddings.mjs";
import { EMBEDDING_VERSION, LOCAL_COLLECTION, validateCollectionDescriptor } from "./movie-vector-store.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION, inspectV2Collection,
  makeV2MovieDocument, v2IdFilter } from "./vector-schema.mjs";

export const LEGACY_MIGRATION_RECORDS = 10;
const DOCUMENT_FIELDS = ["content_type", "title", "year", "genre", "plot", "source_url",
  "content_hash", "embedding_provider", "embedding_model", "model_revision",
  "embedding_version", "chunk_count"];
const DOCUMENT_PROJECTION = Object.freeze({ _id: 1, $vector: 1,
  ...Object.fromEntries(DOCUMENT_FIELDS.map((field) => [field, 1])) });

export class MigrationPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationPlanError";
  }
}

export function parseMigrationArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
    return { mode: "dry-run" };
  }
  if (args.length === 2 && new Set(args).size === 2 &&
      args.includes("--apply") && args.includes("--confirm-v2-migration")) {
    return { mode: "apply" };
  }
  throw new MigrationPlanError("Use no options, --dry-run, or both --apply and --confirm-v2-migration. Live execution remains gated.");
}

export function localVectorValues(value) {
  const values = value instanceof DataAPIVector ? value.asArray() : value;
  validateEmbeddingVectors([values], 1, LOCAL_DIMENSIONS);
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
    throw new MigrationPlanError("Stored local vector does not have a valid unit L2 norm.");
  }
  return values;
}

export function matchesExpectedDocument(stored, expected) {
  if (!stored || stored._id !== expected._id ||
      DOCUMENT_FIELDS.some((field) => stored[field] !== expected[field])) return false;
  const actualVector = localVectorValues(stored.$vector);
  return actualVector.every((value, index) => Math.abs(value - expected.$vector[index]) <= 1e-5);
}

export const V2_LIVE_VERIFICATION_CHECKS = Object.freeze([
  "descriptor: 384 dimensions, cosine metric, client-supplied vectors, exact allowlist",
  "exact _id readback and complete plot/source URL/hash/provenance comparison",
  "genre, year, and content_type filters using indexed metadata",
  "nearest-neighbor $vector similarity with and without an indexed metadata filter",
  "legacy count, IDs, metadata, hashes, and vectors unchanged",
]);

export async function makeVerifiedMigrationDocument(movie, provider, inspectCache = inspectMovieCache) {
  let cache;
  try { cache = await inspectCache(movie, provider); }
  catch { throw new MigrationPlanError(`Could not verify local cache for ${movie.id}.`); }
  if (cache?.cached?.status !== "hit") {
    throw new MigrationPlanError(`Verified local cache is required for ${movie.id}.`);
  }
  const entry = cache.cached.entry;
  try {
    return makeV2MovieDocument(movie, { id: movie.id, vector: entry.vector,
      sourceHash: cache.identity.sourceHash, chunkCount: entry.chunkCount,
      chunks: entry.chunks, provenance: cache.identity,
      cacheIntegrityHash: entry.integrityHash });
  } catch {
    throw new MigrationPlanError(`Local provenance or vector is invalid for ${movie.id}.`);
  }
}

/** Read-only ten-record plan. No collection-management or document-write method is called. */
export async function planV2Migration({ db, movies, provider,
  inspectCache = inspectMovieCache, expectedDatasetCount = 1100 }) {
  validateFullDataset(movies, expectedDatasetCount);
  if (provider?.id !== "local" || provider.modelId !== LOCAL_MODEL_ID ||
      provider.modelRevision !== LOCAL_MODEL_REVISION || provider.dimensions !== LOCAL_DIMENSIONS) {
    throw new MigrationPlanError("Migration requires the pinned local 384-dimensional provider.");
  }
  const descriptors = await db.listCollections();
  validateCollectionDescriptor(descriptors.find((item) => item.name === LOCAL_COLLECTION));
  const destination = await inspectV2Collection({
    listCollections: async () => descriptors,
    collection: (name) => db.collection(name),
  });
  const legacy = db.collection(LOCAL_COLLECTION);
  const legacyCount = await legacy.countDocuments({}, LEGACY_MIGRATION_RECORDS + 1);
  if (legacyCount !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("Legacy collection must contain exactly ten verified sample records.");
  }
  const legacyDocs = await legacy.find({}, { limit: LEGACY_MIGRATION_RECORDS + 1,
    projection: DOCUMENT_PROJECTION }).toArray();
  if (legacyDocs.length !== legacyCount ||
      legacyDocs.some((item) => typeof item?._id !== "string" ||
        !/^movie_[a-f0-9]{20,64}$/u.test(item._id)) ||
      new Set(legacyDocs.map((item) => item._id)).size !== legacyCount) {
    throw new MigrationPlanError("Legacy inventory is incomplete or contains duplicate IDs.");
  }
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const records = [];
  const snapshot = [];
  for (const stored of [...legacyDocs].sort((a, b) => a._id.localeCompare(b._id))) {
    const movie = moviesById.get(stored._id);
    if (!movie) throw new MigrationPlanError(`Legacy ID ${stored._id} is not in the current dataset.`);
    let expected;
    try {
      expected = await makeVerifiedMigrationDocument(movie, provider, inspectCache);
      if (!matchesExpectedDocument(stored, expected)) {
        throw new MigrationPlanError(`Legacy metadata, hash, or vector differs for ${movie.id}.`);
      }
    } catch (error) {
      if (error instanceof MigrationPlanError) throw error;
      throw new MigrationPlanError(`Legacy provenance or vector is invalid for ${movie.id}.`);
    }
    const found = destination.collection
      ? await destination.collection.findOne(v2IdFilter(movie.id),
        { projection: DOCUMENT_PROJECTION }) : null;
    let destinationStatus = "copy-after-approval";
    if (found) {
      try { destinationStatus = matchesExpectedDocument(found, expected) ? "already-matching" : "conflict"; }
      catch { destinationStatus = "conflict"; }
    }
    records.push({ id: movie.id, sourceHash: expected.content_hash,
      destinationStatus, readbackAfterFutureWrite: destinationStatus === "copy-after-approval" });
    snapshot.push({ ...stored, $vector: localVectorValues(stored.$vector) });
  }
  const counts = { copyAfterApproval: records.filter((item) => item.destinationStatus === "copy-after-approval").length,
    alreadyMatching: records.filter((item) => item.destinationStatus === "already-matching").length,
    conflicts: records.filter((item) => item.destinationStatus === "conflict").length };
  const legacySnapshotHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return { mode: "dry-run", executionEnabled: false, databaseWrites: 0,
    inferenceCalls: 0, legacyCollection: LOCAL_COLLECTION,
    legacyCount, legacySnapshotHash, destinationCollection: V2_COLLECTION,
    destinationState: destination.state, proposedDefinition: V2_COLLECTION_DEFINITION,
    provider: "local", model: LOCAL_MODEL_ID, revision: LOCAL_MODEL_REVISION,
    dimensions: LOCAL_DIMENSIONS, embeddingVersion: EMBEDDING_VERSION,
    records, counts, hasBlockingRecordConflicts: counts.conflicts > 0,
    liveExecutionAvailable: false,
    liveVerification: { status: "pending; v2 has not been live-verified in this milestone",
      checks: V2_LIVE_VERIFICATION_CHECKS },
    futureWritePolicy: "After separate approval, write one checked document at a time and read back each result; reconcile uncertain writes before retrying." };
}
