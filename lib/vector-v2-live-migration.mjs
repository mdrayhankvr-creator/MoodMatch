import { LOCAL_COLLECTION, validateCollectionDescriptor } from "./movie-vector-store.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./embedding-provider.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION, inspectV2Collection,
  v2IdFilter, v2MetadataFilter } from "./vector-schema.mjs";
import { LEGACY_MIGRATION_RECORDS, MigrationPlanError,
  makeVerifiedMigrationDocument, matchesExpectedDocument,
  planV2Migration } from "./vector-migration-plan.mjs";

// The reviewed ten-record scope remains pinned below. Apply is closed after the
// partial live run; a later reviewed code change is required to resume writes.
const LIVE_MIGRATION_APPROVED = false;
export const APPROVED_LEGACY_SNAPSHOT_HASH = "2126ad176c046aa4c1e728a00ef982fafdd8efe4c38e2d64b11a8c810723bae4";
export const APPROVED_V2_MIGRATION_RECORDS = Object.freeze([
  ["movie_1a48f19ff37d2ebd6587", "7b7a60d759592680f853becbb9415d9b6b5efb5fa08894e2e6fa389d6d79774d"],
  ["movie_1c3a15d7458a665cb4b0", "21a5a5663b5383b3d9c669b7d2802b6b5a763208b3461e3d0abd8f51bad64c87"],
  ["movie_2324dca90f20e68b6506", "fb5c4a7b2cc9a1fa0ca1b2b94fc92c2fd3a91f4703197c5d2759410fe88acb26"],
  ["movie_291791a7023c7142a461", "b32adcb96df7c2cb3d3ef872fc125957a782ec706d8d6cd2bfd32b0de0a641c9"],
  ["movie_4059449640323dea46a1", "da88fbcb8d50353eb78dfe00c951b17c60c33eb3511e4d1816089b38e958b037"],
  ["movie_75815234577520e0e9a0", "237681a96f8c18cb817e634f4957610e6d2d62c65c51aab33bce123d18377fe2"],
  ["movie_85756b984da7bede7e0f", "ba6bd991557c92ed3fb01ebdb1b1fc6bfefe91438d7eccd31d0742f1f04cb9b0"],
  ["movie_8f86ea94b9f4f2c7388c", "530b1dfb7583b2563f9829b5823187bc3370f34b65147b867f59d681aba423cc"],
  ["movie_a27a1114f9e4cd9adb12", "e684f889e928ee93ad49c7eac54129ba08f2cabf54ccd89c0c9cef6b210abdde"],
  ["movie_e438309a72dfda243a5b", "e21623da2a1cc9671caa2de767eba6ad89802124e2081fb5946ec29989ee8081"],
].map(([id, sourceHash]) => Object.freeze({ id, sourceHash })));
const READBACK_PROJECTION = Object.freeze({ _id: 1, $vector: 1,
  content_type: 1, title: 1, year: 1, genre: 1, plot: 1, source_url: 1,
  content_hash: 1, embedding_provider: 1, embedding_model: 1,
  model_revision: 1, embedding_version: 1, chunk_count: 1 });

export function assertV2MigrationApproved() {
  if (!LIVE_MIGRATION_APPROVED) {
    throw new MigrationPlanError("Live v2 migration is paused after a partial run; the hardcoded approval gate is closed.");
  }
}

export function assertApprovedV2MigrationScope(plan) {
  if (plan?.legacyCollection !== LOCAL_COLLECTION ||
      plan.destinationCollection !== V2_COLLECTION ||
      plan.legacyCount !== LEGACY_MIGRATION_RECORDS ||
      plan.legacySnapshotHash !== APPROVED_LEGACY_SNAPSHOT_HASH ||
      plan.provider !== "local" || plan.model !== LOCAL_MODEL_ID ||
      plan.revision !== LOCAL_MODEL_REVISION || plan.dimensions !== LOCAL_DIMENSIONS ||
      !["missing", "compatible"].includes(plan.destinationState) ||
      plan.hasBlockingRecordConflicts ||
      plan.counts?.conflicts !== 0 ||
      plan.counts.copyAfterApproval + plan.counts.alreadyMatching !== LEGACY_MIGRATION_RECORDS ||
      !Array.isArray(plan.records) || plan.records.length !== LEGACY_MIGRATION_RECORDS ||
      plan.records.some((record, index) => record?.id !== APPROVED_V2_MIGRATION_RECORDS[index].id ||
        record.sourceHash !== APPROVED_V2_MIGRATION_RECORDS[index].sourceHash ||
        !["copy-after-approval", "already-matching"].includes(record.destinationStatus))) {
    throw new MigrationPlanError("Migration plan is outside the approved ten-record v2 scope.");
  }
  return true;
}

export class MigrationExecutionError extends MigrationPlanError {
  constructor(results, cause, phase = "unknown") {
    super("Controlled v2 migration stopped; inspect the partial result and reconcile by dry-run.");
    this.name = "MigrationExecutionError";
    this.results = results.map(({ id, status }) => ({ id, status }));
    this.phase = phase;
    this.cause = cause;
  }
}

export async function verifyV2Descriptor(db) {
  const result = await inspectV2Collection(db);
  if (result.state !== "compatible") {
    throw new MigrationPlanError("V2 collection is missing; live verification cannot run.");
  }
  return result.collection;
}

/** Read-only reconciliation for an uncertain create response; never retries creation. */
export async function reconcileV2CreationFailure(db, error) {
  const found = (await db.listCollections()).some((item) => item.name === V2_COLLECTION);
  if (!found) throw error;
  return verifyV2Descriptor(db);
}

export async function verifyExactV2Document(collection, expected) {
  const stored = await collection.findOne(v2IdFilter(expected._id),
    { projection: READBACK_PROJECTION });
  let matches = false;
  try { matches = matchesExpectedDocument(stored, expected); } catch { /* Invalid stored vector. */ }
  if (!matches || await collection.countDocuments(v2IdFilter(expected._id), 2) !== 1) {
    throw new MigrationPlanError(`V2 readback mismatch for ${expected._id}.`);
  }
  return true;
}

export async function verifyV2Inventory(collection, records, { requireComplete = false } = {}) {
  if (records.length !== LEGACY_MIGRATION_RECORDS ||
      new Set(records.map((record) => record.id)).size !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("V2 inventory requires exactly ten unique planned IDs.");
  }
  const expectedHashes = new Map(records.map(({ id, sourceHash }) => [id, sourceHash]));
  const count = await collection.countDocuments({}, LEGACY_MIGRATION_RECORDS + 1);
  if (count > LEGACY_MIGRATION_RECORDS || (requireComplete && count !== LEGACY_MIGRATION_RECORDS)) {
    throw new MigrationPlanError("V2 collection contains an unexpected document count.");
  }
  const docs = await collection.find({}, { limit: LEGACY_MIGRATION_RECORDS + 1,
    projection: { _id: 1, content_hash: 1 } }).toArray();
  if (docs.length !== count || new Set(docs.map((doc) => doc._id)).size !== count ||
      docs.some((doc) => !expectedHashes.has(doc._id) ||
        expectedHashes.get(doc._id) !== doc.content_hash)) {
    throw new MigrationPlanError("V2 collection contains an unknown ID or mismatched source hash.");
  }
  return { count, hashesVerified: count };
}

export async function verifyV2MetadataFilters(collection, expectedDocuments) {
  const samples = {
    content_type: expectedDocuments.find((doc) => doc.content_type === "movie"),
    genre: expectedDocuments.find((doc) => typeof doc.genre === "string" && doc.genre.length > 0),
    year: expectedDocuments.find((doc) => Number.isSafeInteger(doc.year)),
  };
  const verified = [];
  for (const [field, sample] of Object.entries(samples)) {
    if (!sample) throw new MigrationPlanError(`No safe ${field} filter sample is available.`);
    const filter = v2MetadataFilter(field, sample[field]);
    const rows = await collection.find(filter, { limit: LEGACY_MIGRATION_RECORDS + 1,
      projection: { _id: 1 } }).toArray();
    const matching = new Set(expectedDocuments.filter((doc) => doc[field] === sample[field])
      .map((doc) => doc._id));
    if (rows.length !== matching.size ||
        new Set(rows.map((row) => row._id)).size !== matching.size ||
        rows.some((row) => !matching.has(row._id))) {
      throw new MigrationPlanError(`V2 ${field} filter verification failed.`);
    }
    verified.push(field);
  }
  return verified;
}

export async function verifyV2VectorSearch(collection, expectedDocuments) {
  const sample = expectedDocuments[0];
  if (!sample) throw new MigrationPlanError("No v2 vector query sample is available.");
  const knownIds = new Set(expectedDocuments.map((doc) => doc._id));
  const scores = [];
  for (const filter of [{}, v2MetadataFilter("content_type", "movie")]) {
    const rows = await collection.find(filter, {
      sort: { $vector: sample.$vector }, limit: 1,
      projection: { _id: 1 }, includeSimilarity: true,
    }).toArray();
    if (rows.length !== 1 || rows[0]._id !== sample._id ||
        !knownIds.has(rows[0]._id) || !Number.isFinite(rows[0].$similarity)) {
      throw new MigrationPlanError("V2 vector similarity verification failed.");
    }
    scores.push(rows[0].$similarity);
  }
  return { unfilteredScore: scores[0], filteredScore: scores[1] };
}

export async function verifyV2LiveState({ db, movies, provider, baselineSnapshot,
  inspectCache, expectedDatasetCount = 1100 }) {
  const collection = await verifyV2Descriptor(db);
  const plan = await planV2Migration({ db, movies, provider, inspectCache,
    expectedDatasetCount });
  if (plan.legacySnapshotHash !== baselineSnapshot ||
      plan.legacyCollection !== LOCAL_COLLECTION ||
      plan.legacyCount !== LEGACY_MIGRATION_RECORDS ||
      plan.counts.alreadyMatching !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("Legacy snapshot changed or v2 migration is incomplete.");
  }
  await verifyV2Inventory(collection, plan.records, { requireComplete: true });
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const expectedDocuments = [];
  for (const { id } of plan.records) {
    const expected = await makeVerifiedMigrationDocument(moviesById.get(id), provider, inspectCache);
    await verifyExactV2Document(collection, expected);
    expectedDocuments.push(expected);
  }
  const filters = await verifyV2MetadataFilters(collection, expectedDocuments);
  const similarityScores = await verifyV2VectorSearch(collection, expectedDocuments);
  const legacyDescriptor = (await db.listCollections()).find((item) => item.name === LOCAL_COLLECTION);
  validateCollectionDescriptor(legacyDescriptor);
  const finalPlan = await planV2Migration({ db, movies, provider, inspectCache,
    expectedDatasetCount });
  if (finalPlan.legacySnapshotHash !== baselineSnapshot ||
      finalPlan.counts.alreadyMatching !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("Legacy snapshot or v2 records changed during verification.");
  }
  return { documents: LEGACY_MIGRATION_RECORDS, hashesVerified: true,
    completePlotsVerified: true, filters, vectorSearchVerified: true, similarityScores,
    legacySnapshotUnchanged: true };
}

/** Only the scoped executor can reach collection creation. */
async function ensureV2Collection(db, approvedPlan) {
  assertApprovedV2MigrationScope(approvedPlan);
  const descriptors = await db.listCollections();
  validateCollectionDescriptor(descriptors.find((item) => item.name === LOCAL_COLLECTION));
  const existing = descriptors.find((item) => item.name === V2_COLLECTION);
  if (existing) return { state: "reused", collection: await verifyV2Descriptor(db) };
  try {
    await db.createCollection(V2_COLLECTION, V2_COLLECTION_DEFINITION);
  } catch (error) {
    // A concurrent creator may have won. Reuse only an exact compatible descriptor.
    return { state: "created-or-raced", collection: await reconcileV2CreationFailure(db, error) };
  }
  return { state: "created-or-raced", collection: await verifyV2Descriptor(db) };
}

/** Only the ten pinned identities can be copied; no flag or environment value expands this scope. */
export async function executeV2Migration({ db, movies, provider, inspectCache }) {
  assertV2MigrationApproved();
  const initial = await planV2Migration({ db, movies, provider, inspectCache });
  assertApprovedV2MigrationScope(initial);
  if (initial.hasBlockingRecordConflicts) {
    throw new MigrationPlanError("V2 destination contains conflicting documents.");
  }
  if (initial.destinationState === "compatible") {
    await verifyV2Inventory(db.collection(V2_COLLECTION), initial.records);
  }
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const results = [];
  let phase = "create-or-reuse-collection";
  try {
    const { collection } = await ensureV2Collection(db, initial);
    for (const { id } of initial.records) {
      phase = `verify-and-copy:${id}`;
      const current = await planV2Migration({ db, movies, provider, inspectCache });
      assertApprovedV2MigrationScope(current);
      await verifyV2Inventory(collection, current.records);
      const record = current.records.find((item) => item.id === id);
      const expected = await makeVerifiedMigrationDocument(moviesById.get(id), provider, inspectCache);
      const legacy = await db.collection(LOCAL_COLLECTION).findOne(v2IdFilter(id),
        { projection: READBACK_PROJECTION });
      if (!matchesExpectedDocument(legacy, expected) ||
          expected.content_hash !== record.sourceHash) {
        throw new MigrationPlanError(`Legacy document or cache changed for ${id}.`);
      }
      if (record.destinationStatus === "already-matching") {
        await verifyExactV2Document(collection, expected);
        results.push({ id, status: "already-matching" });
        continue;
      }
      const existing = await collection.findOne(v2IdFilter(id),
        { projection: READBACK_PROJECTION });
      if (existing) {
        await verifyExactV2Document(collection, expected);
        results.push({ id, status: "already-matching" });
        continue;
      }
      try {
        await collection.insertOne(expected); // Create-only: never replace a conflicting ID.
      } catch {
        // An uncertain insert or concurrent writer is reconciled by exact readback.
        await verifyExactV2Document(collection, expected);
        results.push({ id, status: "reconciled" });
        continue;
      }
      await verifyExactV2Document(collection, expected);
      results.push({ id, status: "inserted" });
    }
    phase = "final-verification";
    const verification = await verifyV2LiveState({ db, movies, provider,
      baselineSnapshot: initial.legacySnapshotHash, inspectCache });
    return { results, verification };
  } catch (error) {
    throw new MigrationExecutionError(results, error, phase);
  }
}
