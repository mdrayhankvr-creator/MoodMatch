import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPROVED_FULL_V2_DATASET_HASH, loadLocalPrepCheckpoint,
  localPrepExpected, newLocalPrepCheckpoint,
  validateLocalPrepCheckpoint } from "../lib/full-v2-local-prep.mjs";
import { writeIngestionCheckpoint } from "../lib/ingestion-checkpoint.mjs";
import { APPROVED_V2_MIGRATION_RECORDS } from "../lib/vector-v2-live-migration.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

function readiness() {
  const records = [
    ...APPROVED_V2_MIGRATION_RECORDS.map(({ id, sourceHash }) =>
      ({ id, sourceHash, chunks: 1, cache: "reusable" })),
    ...Array.from({ length: 1090 }, (_, index) => ({
      id: `movie_${(index + 1).toString(16).padStart(20, "0")}`,
      sourceHash: hash(String(index)), chunks: index % 3 + 1, cache: "missing",
    })),
  ];
  return { datasetHash: APPROVED_FULL_V2_DATASET_HASH, records };
}

test("local preparation binds exactly 1,090 IDs to the reviewed source and sample hashes", () => {
  const source = readiness();
  const expected = localPrepExpected(source, APPROVED_FULL_V2_DATASET_HASH);
  assert.equal(expected.orderedIds.length, 1090);
  assert.equal(expected.sourceHashes.size, 1090);
  assert.equal(new Set(expected.orderedIds).size, 1090);
  assert.throws(() => localPrepExpected(source, hash("different")), /fingerprint/);
  source.records[0] = { ...source.records[0], sourceHash: hash("changed") };
  assert.throws(() => localPrepExpected(source, APPROVED_FULL_V2_DATASET_HASH),
    /sample source hashes/);
});

test("local preparation checkpoint is atomic and rejects stale or corrupt progress", async (t) => {
  const expected = localPrepExpected(readiness(), APPROVED_FULL_V2_DATASET_HASH);
  const directory = await mkdtemp(join(tmpdir(), "moodmatch-local-prep-test-"));
  t.after(async () => {
    if (directory.startsWith(tmpdir())) await rm(directory, { recursive: true });
  });
  const path = join(directory, "checkpoint.json");
  const initial = await loadLocalPrepCheckpoint(path, expected);
  assert.equal(initial.resumed, false);
  const id = expected.orderedIds[0];
  const state = newLocalPrepCheckpoint(expected);
  state.records[id] = { status: "cached", sourceHash: expected.sourceHashes.get(id),
    chunkCount: 1, inferenceCalls: 1 };
  await writeIngestionCheckpoint(path, state);
  const loaded = await loadLocalPrepCheckpoint(path, expected);
  assert.equal(loaded.resumed, true);
  assert.deepEqual(loaded.state.records[id], state.records[id]);
  assert.throws(() => validateLocalPrepCheckpoint(state,
    { ...expected, configHash: hash("changed") }), /incompatible/);
  assert.throws(() => validateLocalPrepCheckpoint({ ...state,
    records: { ...state.records, movie_ffffffffffffffffffff: state.records[id] } },
  expected), /invalid/);
  assert.throws(() => validateLocalPrepCheckpoint({ ...state,
    records: { [id]: { ...state.records[id], inferenceCalls: 2 } } },
  expected), /invalid/);
});
