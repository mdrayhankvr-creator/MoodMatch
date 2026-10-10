import { performance } from "node:perf_hooks";
import { DataAPIHttpError, DataAPIResponseError, DataAPITimeoutError } from "@datastax/astra-db-ts";
import { LOCAL_COLLECTION, validateCollectionDescriptor } from "./movie-vector-store.mjs";
import { LOCAL_DIMENSIONS, LOCAL_MODEL_ID, LOCAL_MODEL_REVISION } from "./embedding-provider.mjs";
import { V2_COLLECTION, inspectV2Collection,
  v2IdFilter, v2MetadataFilter } from "./vector-schema.mjs";
import { LEGACY_MIGRATION_RECORDS, MigrationPlanError, MigrationReadError,
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
const RESUME_ALREADY_MIGRATED_IDS = Object.freeze(APPROVED_V2_MIGRATION_RECORDS.slice(0, 3)
  .map((record) => record.id));
export const APPROVED_V2_RESUME_IDS = Object.freeze(APPROVED_V2_MIGRATION_RECORDS.slice(3)
  .map((record) => record.id));
const READBACK_DELAYS_MS = Object.freeze([100, 250]); // Three reads total; no write retry.
const SAFE_OPERATIONS = new Set(["insertOne", "findOne", "find", "find.toArray",
  "comparison", "countDocuments"]);

export function assertV2MigrationApproved() {
  if (!LIVE_MIGRATION_APPROVED) {
    throw new MigrationPlanError("Live v2 migration is disabled; the hardcoded approval gate is closed.");
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
      plan.records.filter((record) => record?.destinationStatus === "copy-after-approval").length !==
        plan.counts.copyAfterApproval ||
      plan.records.filter((record) => record?.destinationStatus === "already-matching").length !==
        plan.counts.alreadyMatching ||
      plan.records.some((record, index) => record?.id !== APPROVED_V2_MIGRATION_RECORDS[index].id ||
        record.sourceHash !== APPROVED_V2_MIGRATION_RECORDS[index].sourceHash ||
        !["copy-after-approval", "already-matching"].includes(record.destinationStatus))) {
    throw new MigrationPlanError("Migration plan is outside the approved ten-record v2 scope.");
  }
  return true;
}

/** The resumed run can only advance from the three already verified v2 IDs. */
export function assertApprovedV2ResumePlan(plan) {
  assertApprovedV2MigrationScope(plan);
  if (plan.destinationState !== "compatible" ||
      plan.counts.alreadyMatching < RESUME_ALREADY_MIGRATED_IDS.length ||
      plan.counts.copyAfterApproval > LEGACY_MIGRATION_RECORDS - RESUME_ALREADY_MIGRATED_IDS.length ||
      RESUME_ALREADY_MIGRATED_IDS.some((id) =>
        plan.records.find((record) => record.id === id)?.destinationStatus !== "already-matching")) {
    throw new MigrationPlanError("V2 resume plan is outside the approved partial-migration scope.");
  }
  return true;
}

export class MigrationOperationError extends MigrationPlanError {
  constructor(operation, cause, elapsedMs, reason = "sdk", details = {}) {
    super(reason === "integrity" || reason === "missing"
      ? "V2 readback mismatch or conflict; migration stopped."
      : `V2 ${operation} failed; migration stopped.`);
    this.name = "MigrationOperationError";
    this.operation = operation;
    this.elapsedMs = Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : 0;
    this.reason = reason;
    this.cause = cause;
    // Retained for diagnosis, never serialized by the CLI.
    this.insertError = details.insertError;
    this.reconciliationError = details.reconciliationError;
  }
}

/** A deliberately narrow projection of an exception; SDK messages and bodies are unsafe to log. */
export function sanitizeMigrationFailure(error) {
  const failure = error instanceof MigrationExecutionError ? error.cause : error;
  const operational = failure instanceof MigrationOperationError || failure instanceof MigrationReadError;
  const operation = operational && SAFE_OPERATIONS.has(failure.operation)
    ? failure.operation : "unknown";
  const original = operational ? failure.cause : failure;
  let category = "unknown";
  let errorClass = "UnknownError";
  if (operational && ["integrity", "invalid"].includes(failure.reason)) {
    category = "integrity";
  } else if (operational && failure.reason === "missing") {
    category = "readback-missing";
  } else if (original instanceof DataAPITimeoutError) {
    category = "timeout";
  } else if (original instanceof DataAPIHttpError) {
    category = "http";
  } else if (original instanceof DataAPIResponseError) {
    category = "api-response";
  } else if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]
    .includes(original?.code ?? original?.cause?.code)) {
    category = "network";
  } else if (operational && failure.reason === "uncertain") {
    category = "uncertain-write";
  } else if (original instanceof MigrationPlanError) {
    category = "validation";
  }
  if (original instanceof DataAPITimeoutError) errorClass = "DataAPITimeoutError";
  else if (original instanceof DataAPIHttpError) errorClass = "DataAPIHttpError";
  else if (original instanceof DataAPIResponseError) errorClass = "DataAPIResponseError";
  else if (original instanceof MigrationPlanError) errorClass = "MigrationPlanError";
  else if (original instanceof Error) errorClass = "Error";
  const status = original instanceof DataAPIHttpError ? original.status : undefined;
  const httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  const descriptorCode = original instanceof DataAPIResponseError
    ? original.errorDescriptors?.[0]?.errorCode : undefined;
  const apiCode = typeof descriptorCode === "string" && /^[A-Z][A-Z0-9_]{0,95}$/u.test(descriptorCode)
    ? descriptorCode : null;
  const summary = { operation, category, errorClass, httpStatus, apiCode,
    elapsedMs: operational ? failure.elapsedMs : null };
  if (failure instanceof MigrationOperationError && failure.reconciliationError) {
    summary.reconciliation = sanitizeMigrationFailure(failure.reconciliationError);
  }
  return summary;
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

async function readExactV2DocumentOnce(collection, expected) {
  let started = performance.now();
  let stored;
  try {
    stored = await collection.findOne(v2IdFilter(expected._id),
      { projection: READBACK_PROJECTION });
  } catch (error) {
    throw new MigrationOperationError("findOne", error, performance.now() - started);
  }
  if (!stored) return false;
  started = performance.now();
  let matches;
  try {
    matches = matchesExpectedDocument(stored, expected);
  } catch (error) {
    throw new MigrationOperationError("comparison", error, performance.now() - started, "integrity");
  }
  if (!matches) {
    throw new MigrationOperationError("comparison", new MigrationPlanError("Stored document differs."),
      performance.now() - started, "integrity");
  }
  started = performance.now();
  let count;
  try {
    count = await collection.countDocuments(v2IdFilter(expected._id), 2);
  } catch (error) {
    throw new MigrationOperationError("countDocuments", error, performance.now() - started);
  }
  if (count !== 1) {
    throw new MigrationOperationError("countDocuments", new MigrationPlanError("Exact ID count differs."),
      performance.now() - started, count === 0 ? "missing" : "integrity");
  }
  return true;
}

export async function verifyExactV2Document(collection, expected) {
  if (!await readExactV2DocumentOnce(collection, expected)) {
    throw new MigrationOperationError("findOne", new MigrationPlanError("Document absent."),
      0, "missing");
  }
  return true;
}

async function boundedExactV2Readback(collection, expected, sleep) {
  let lastError;
  for (let attempt = 0; attempt <= READBACK_DELAYS_MS.length; attempt += 1) {
    try {
      if (await readExactV2DocumentOnce(collection, expected)) return true;
      lastError = new MigrationOperationError("findOne", new MigrationPlanError("Document absent."),
        0, "missing");
    } catch (error) {
      if (!(error instanceof MigrationOperationError) || error.reason === "integrity") throw error;
      lastError = error;
    }
    if (attempt < READBACK_DELAYS_MS.length) await sleep(READBACK_DELAYS_MS[attempt]);
  }
  throw lastError;
}

const waitForReadback = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Reconcile an uncertain insert with at most three exact-ID reads and no writes. */
export async function reconcileUncertainV2Write(collection, expected, insertError,
  { sleep = waitForReadback, insertElapsedMs = 0 } = {}) {
  try {
    return await boundedExactV2Readback(collection, expected, sleep);
  } catch (reconciliationError) {
    if (reconciliationError instanceof MigrationOperationError &&
        reconciliationError.reason === "integrity") {
      reconciliationError.insertError = insertError;
      throw reconciliationError;
    }
    throw new MigrationOperationError("insertOne", insertError, insertElapsedMs, "uncertain",
      { reconciliationError });
  }
}

async function timedRead(operation, callback) {
  const started = performance.now();
  try { return await callback(); }
  catch (error) { throw new MigrationOperationError(operation, error, performance.now() - started); }
}

export async function verifyV2Inventory(collection, records, { requireComplete = false } = {}) {
  if (records.length !== LEGACY_MIGRATION_RECORDS ||
      new Set(records.map((record) => record.id)).size !== LEGACY_MIGRATION_RECORDS) {
    throw new MigrationPlanError("V2 inventory requires exactly ten unique planned IDs.");
  }
  const expectedHashes = new Map(records.map(({ id, sourceHash }) => [id, sourceHash]));
  const count = await timedRead("countDocuments",
    () => collection.countDocuments({}, LEGACY_MIGRATION_RECORDS + 1));
  if (count > LEGACY_MIGRATION_RECORDS || (requireComplete && count !== LEGACY_MIGRATION_RECORDS)) {
    throw new MigrationPlanError("V2 collection contains an unexpected document count.");
  }
  const docs = await timedRead("find", () => collection.find({}, {
    limit: LEGACY_MIGRATION_RECORDS + 1,
    projection: { _id: 1, content_hash: 1 },
  }).toArray());
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

/** Only the ten pinned identities can be copied; no flag or environment value expands this scope. */
export async function executeV2Migration({ db, movies, provider, inspectCache }) {
  assertV2MigrationApproved();
  const initial = await planV2Migration({ db, movies, provider, inspectCache });
  assertApprovedV2ResumePlan(initial);
  const collection = await verifyV2Descriptor(db);
  await verifyV2Inventory(collection, initial.records);
  const moviesById = new Map(movies.map((movie) => [movie.id, movie]));
  const results = [];
  let phase = "reconcile-existing-collection";
  try {
    for (const { id } of initial.records) {
      phase = `verify-and-copy:${id}`;
      const current = await planV2Migration({ db, movies, provider, inspectCache });
      assertApprovedV2ResumePlan(current);
      await verifyV2Inventory(collection, current.records);
      const record = current.records.find((item) => item.id === id);
      const expected = await makeVerifiedMigrationDocument(moviesById.get(id), provider, inspectCache);
      const legacyCollection = db.collection(LOCAL_COLLECTION);
      if (!await readExactV2DocumentOnce(legacyCollection, expected) ||
          expected.content_hash !== record.sourceHash) {
        throw new MigrationPlanError(`Legacy document or cache changed for ${id}.`);
      }
      if (record.destinationStatus === "already-matching") {
        await boundedExactV2Readback(collection, expected, waitForReadback);
        results.push({ id, status: "already-matching" });
        continue;
      }
      if (!APPROVED_V2_RESUME_IDS.includes(id)) {
        throw new MigrationPlanError("V2 write ID is outside the approved seven-record resume scope.");
      }
      if (await readExactV2DocumentOnce(collection, expected)) {
        results.push({ id, status: "already-matching" });
        continue;
      }
      const insertStarted = performance.now();
      try {
        await collection.insertOne(expected); // Create-only: never replace a conflicting ID.
      } catch (error) {
        // The insert may have committed. Reconcile by reads; never issue a second insert here.
        await reconcileUncertainV2Write(collection, expected, error,
          { insertElapsedMs: performance.now() - insertStarted });
        results.push({ id, status: "reconciled" });
        continue;
      }
      await boundedExactV2Readback(collection, expected, waitForReadback);
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
