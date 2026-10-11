import { LOCAL_COLLECTION } from "./movie-vector-store.mjs";
import { APPROVED_FULL_V2_DATASET_HASH } from "./full-v2-ingestion.mjs";
import { buildFullReadinessPlan } from "./full-ingestion-readiness.mjs";
import { APPROVED_LEGACY_SNAPSHOT_HASH, verifyV2Descriptor } from "./vector-v2-live-migration.mjs";
import { matchesExpectedDocument, planV2Migration } from "./vector-migration-plan.mjs";
import { resolveLocalVectorCollection, v2MetadataFilter } from "./vector-schema.mjs";

const SOURCE_TOTAL = 1100;
const DOCUMENT_PROJECTION = Object.freeze({ _id: 1, $vector: 1,
  content_type: 1, title: 1, year: 1, genre: 1, plot: 1, source_url: 1,
  content_hash: 1, embedding_provider: 1, embedding_model: 1,
  model_revision: 1, embedding_version: 1, chunk_count: 1 });

/** A paginated full-document scan avoids Astra's 1,000-document count ceiling. */
export async function verifyFullV2DocumentScan(collection, expectedDocuments) {
  if (expectedDocuments.size !== SOURCE_TOTAL) {
    throw new Error("Full-v2 scan requires 1,100 cache-verified documents.");
  }
  const rows = await collection.find({}, { limit: SOURCE_TOTAL + 1,
    projection: DOCUMENT_PROJECTION }).toArray();
  const seen = new Set();
  if (rows.length !== SOURCE_TOTAL) {
    throw new Error("Full-v2 scan found missing or unexpected documents.");
  }
  for (const stored of rows) {
    const expected = expectedDocuments.get(stored?._id);
    if (!expected || seen.has(stored._id) || !matchesExpectedDocument(stored, expected)) {
      throw new Error("Full-v2 scan found an unknown ID, duplicate, or content conflict.");
    }
    seen.add(stored._id);
  }
  return [...expectedDocuments.values()];
}

export async function verifyFullV2MetadataFilters(collection, expectedDocuments) {
  if (expectedDocuments.length !== SOURCE_TOTAL) {
    throw new Error("Full-v2 filter verification requires 1,100 expected documents.");
  }
  const samples = {
    content_type: expectedDocuments.find((doc) => doc.content_type === "movie"),
    genre: expectedDocuments.find((doc) => typeof doc.genre === "string" && doc.genre.length > 0),
    year: expectedDocuments.find((doc) => Number.isSafeInteger(doc.year)),
  };
  const verified = [];
  for (const [field, sample] of Object.entries(samples)) {
    if (!sample) throw new Error("A required indexed filter sample is unavailable.");
    const expected = new Set(expectedDocuments.filter((doc) => doc[field] === sample[field])
      .map((doc) => doc._id));
    const rows = await collection.find(v2MetadataFilter(field, sample[field]), {
      limit: SOURCE_TOTAL + 1, projection: { _id: 1 },
    }).toArray();
    if (rows.length !== expected.size ||
        new Set(rows.map((row) => row._id)).size !== expected.size ||
        rows.some((row) => !expected.has(row._id))) {
      throw new Error("Full-v2 indexed metadata filter verification failed.");
    }
    verified.push(field);
  }
  return verified;
}

export async function verifyFullV2Similarity(collection, expectedDocuments) {
  const sample = expectedDocuments[0];
  if (!sample || expectedDocuments.length !== SOURCE_TOTAL) {
    throw new Error("Full-v2 vector verification requires 1,100 expected documents.");
  }
  const results = [];
  for (const filter of [{}, v2MetadataFilter("content_type", "movie")]) {
    const rows = await collection.find(filter, {
      sort: { $vector: sample.$vector }, limit: 10,
      projection: { _id: 1 }, includeSimilarity: true,
    }).toArray();
    const self = rows.find((row) => row._id === sample._id);
    if (!rows.length || rows.length > 10 ||
        rows.some((row) => !Number.isFinite(row.$similarity)) ||
        !self || self.$similarity < 0.99) {
      throw new Error("Full-v2 vector similarity verification failed.");
    }
    results.push(self.$similarity);
  }
  return { selfInTopTen: true, unfilteredScore: results[0], filteredScore: results[1] };
}

/** A separate read-only full-set verification after the insert command finishes. */
export async function verifyFullV2LiveState({ db, movies, provider, datasetHash }) {
  if (datasetHash !== APPROVED_FULL_V2_DATASET_HASH) {
    throw new Error("The reviewed full-v2 source fingerprint changed.");
  }
  const readiness = await buildFullReadinessPlan({ movies, priorityMovies: [],
    provider, datasetHash });
  if (readiness.coverage.reusable !== SOURCE_TOTAL) {
    throw new Error("The full-v2 cache coverage is incomplete.");
  }
  const collection = await verifyV2Descriptor(db);
  const expectedDocuments = await verifyFullV2DocumentScan(collection,
    readiness.expectedDocuments);
  const filters = await verifyFullV2MetadataFilters(collection, expectedDocuments);
  const similarity = await verifyFullV2Similarity(collection, expectedDocuments);
  const legacy = await planV2Migration({ db, movies, provider });
  if (legacy.legacyCollection !== LOCAL_COLLECTION ||
      legacy.legacySnapshotHash !== APPROVED_LEGACY_SNAPSHOT_HASH ||
      legacy.legacyCount !== 10 || legacy.counts.alreadyMatching !== 10) {
    throw new Error("The legacy snapshot changed during full-v2 verification.");
  }
  return { collection: "movies_local_384_v2", matching: SOURCE_TOTAL,
    missing: 0, conflicts: 0, unexpected: 0,
    fullPlotsAndProvenanceVerified: true, vectorsVerified: SOURCE_TOTAL,
    indexedFiltersVerified: filters, similarity,
    legacySnapshotUnchanged: true,
    defaultSearchCollection: resolveLocalVectorCollection(undefined) };
}
