import test from "node:test";
import assert from "node:assert/strict";
import { verifyFullV2DocumentScan, verifyFullV2MetadataFilters,
  verifyFullV2Similarity } from
  "../lib/full-v2-live-verification.mjs";

const documents = Array.from({ length: 1100 }, (_, index) => ({
  _id: `movie_${String(index).padStart(4, "0")}`,
  content_type: "movie",
  genre: index % 2 ? "Drama" : "Comedy",
  year: 2000 + index % 5,
  $vector: [1, ...Array(383).fill(0)],
}));

test("full-set read-only filters require exact returned ID sets", async () => {
  const collection = { find(filter) {
    return { async toArray() {
      return documents.filter((document) => Object.entries(filter).every(
        ([field, value]) => document[field] === value)).map(({ _id }) => ({ _id }));
    } };
  } };
  assert.deepEqual(await verifyFullV2MetadataFilters(collection, documents),
    ["content_type", "genre", "year"]);
  await assert.rejects(verifyFullV2MetadataFilters({ find() {
    return { async toArray() { return []; } };
  } }, documents), /filter verification failed/);
});

test("paginated full-document scan rejects missing, unknown, and changed records", async () => {
  const expected = new Map(documents.map((document) => [document._id, document]));
  const collection = (rows) => ({ find() {
    return { async toArray() { return rows; } };
  } });
  assert.equal((await verifyFullV2DocumentScan(collection(documents), expected)).length,
    1100);
  await assert.rejects(verifyFullV2DocumentScan(collection(documents.slice(1)), expected),
    /missing or unexpected/);
  await assert.rejects(verifyFullV2DocumentScan(collection([
    ...documents.slice(1), { ...documents[0], _id: "unknown" }]), expected),
  /unknown ID/);
  await assert.rejects(verifyFullV2DocumentScan(collection([
    { ...documents[0], plot: "changed" }, ...documents.slice(1)]), expected),
  /content conflict/);
});

test("full-set vector verification requires self in both nearest-neighbor results", async () => {
  const collection = { find() {
    return { async toArray() { return [{ _id: documents[0]._id, $similarity: 1 }]; } };
  } };
  const result = await verifyFullV2Similarity(collection, documents);
  assert.equal(result.selfInTopTen, true);
  await assert.rejects(verifyFullV2Similarity({ find() {
    return { async toArray() { return [{ _id: documents[1]._id, $similarity: 1 }]; } };
  } }, documents), /similarity verification failed/);
});
