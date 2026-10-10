import { LOCAL_COLLECTION, validateCollectionDescriptor } from "./movie-vector-store.mjs";
import { V2_COLLECTION, V2_COLLECTION_DEFINITION, inspectV2Collection,
  v2IdFilter, v2MetadataFilter } from "./vector-schema.mjs";
import { LEGACY_MIGRATION_RECORDS, MigrationPlanError,
  makeVerifiedMigrationDocument, matchesExpectedDocument,
  planV2Migration } from "./vector-migration-plan.mjs";

// M6D.3B only prepares the live path. Enabling it requires a reviewed code change.
const LIVE_MIGRATION_APPROVED = false;
const READBACK_PROJECTION = Object.freeze({ _id: 1, $vector: 1,
  content_type: 1, title: 1, year: 1, genre: 1, plot: 1, source_url: 1,
  content_hash: 1, embedding_provider: 1, embedding_model: 1,
  model_revision: 1, embedding_version: 1, chunk_count: 1 });

export function assertV2MigrationApproved() {
  if (!LIVE_MIGRATION_APPROVED) {
    throw new MigrationPlanError("Live v2 collection creation and migration are disabled by the M6D.3B milestone gate.");
  }
}

export async function verifyV2Descriptor(db) {
  const result = await inspectV2Collection(db);
  if (result.state !== "compatible") {
    throw new MigrationPlanError("V2 collection is missing; live verification cannot run.");
  }
  return result.collection;
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
  for (const filter of [{}, v2MetadataFilter("content_type", "movie")]) {
    const rows = await collection.find(filter, {
      sort: { $vector: sample.$vector }, limit: 1,
      projection: { _id: 1 },
    }).toArray();
    if (rows.length !== 1 || rows[0]._id !== sample._id ||
        !knownIds.has(rows[0]._id)) {
      throw new MigrationPlanError("V2 vector similarity verification failed.");
    }
  }
  return true;
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
  await verifyV2VectorSearch(collection, expectedDocuments);
  const legacyDescriptor = (await db.listCollections()).find((item) => item.name === LOCAL_COLLECTION);
  validateCollectionDescriptor(legacyDescriptor);
  const finalPlan = await planV2Migration({ db, movies, provider, inspectCache,
    expectedDatasetCount });
  if (finalPlan.legacySnapshotHash !== baselineSnapshot ||
      finalPlan.counts.alreadyMatching !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("Legacy snapshot or v2 records changed during verification.");
  }
  return { documents: LEGACY_MIGRATION_RECORDS, hashesVerified: true,
    completePlotsVerified: true, filters, vectorSearchVerified: true,
    legacySnapshotUnchanged: true };
}

/** The approval check runs before the first database read or write. */
export async function ensureV2Collection(db) {
  assertV2MigrationApproved();
  const descriptors = await db.listCollections();
  validateCollectionDescriptor(descriptors.find((item) => item.name === LOCAL_COLLECTION));
  const existing = descriptors.find((item) => item.name === V2_COLLECTION);
  if (existing) return { state: "reused", collection: await verifyV2Descriptor(db) };
  try {
    await db.createCollection(V2_COLLECTION, V2_COLLECTION_DEFINITION);
  } catch (error) {
    // A concurrent creator may have won. Reuse only an exact compatible descriptor.
    const found = (await db.listCollections()).find((item) => item.name === V2_COLLECTION);
    if (!found) throw error;
  }
  return { state: "created-or-raced", collection: await verifyV2Descriptor(db) };
}

/** Future execution path. No caller can pass a flag, token, or config to open the gate. */
export async function executeV2Migration({ db, movies, provider, inspectCache }) {
  assertV2MigrationApproved();
  const initial = await planV2Migration({ db, movies, provider, inspectCache });
  if (initial.hasBlockingRecordConflicts) {
    throw new MigrationPlanError("V2 destination contains conflicting documents.");
  }
  if (initial.destinationState === "compatible") {
    await verifyV2Inventory(db.collection(V2_COLLECTION), initial.records);
  }
  const { collection } = await ensureV2Collection(db);
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const results = [];
  for (const { id } of initial.records) {
    const current = await planV2Migration({ db, movies, provider, inspectCache });
    if (current.legacySnapshotHash !== initial.legacySnapshotHash || current.hasBlockingRecordConflicts) {
      throw new MigrationPlanError("Legacy snapshot or destination changed during migration.");
    }
    await verifyV2Inventory(collection, current.records);
    const record = current.records.find((item) => item.id === id);
    const expected = await makeVerifiedMigrationDocument(moviesById.get(id), provider, inspectCache);
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
  const verification = await verifyV2LiveState({ db, movies, provider,
    baselineSnapshot: initial.legacySnapshotHash, inspectCache });
  return { results, verification };
}
