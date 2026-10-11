import test from "node:test";
import assert from "node:assert/strict";
import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { browseCatalogue, getCatalogueMovie, makeCatalogue,
  publicCatalogueMovie, selectApprovedArtwork } from "../lib/catalogue.mjs";
import { createBrowseHandler, createDetailHandler } from "../lib/catalogue-api.mjs";

const id = `movie_${"a".repeat(20)}`;
const row = { id, title: "A Real Film", year: "2013", genre: "drama, mystery",
  plot: "A full unlicensed plot that must never enter the public response.",
  source_url: "https://en.wikipedia.org/wiki/A_Real_Film" };

test("public catalogue projection preserves source metadata but removes full plots", () => {
  const movie = publicCatalogueMovie(row);
  assert.deepEqual(movie, { id, title: "A Real Film", year: 2013,
    genres: ["drama", "mystery"], contentType: "movie",
    sourceUrl: row.source_url, artwork: null });
  assert.doesNotMatch(JSON.stringify(movie), /unlicensed plot|content_hash|\$vector/u);
  assert.deepEqual(publicCatalogueMovie({ ...row, genre: "", year: "" }).genres, []);
  assert.equal(publicCatalogueMovie({ ...row, year: "" }).year, null);
  assert.throws(() => publicCatalogueMovie({ ...row, source_url: "javascript:bad()" }));
});

test("artwork requires an exact stable ID, local file, creator, file page and approved license", () => {
  assert.equal(selectApprovedArtwork(id), null); // Current reviewed coverage is zero.
  const entry = { path: `/artwork/${id}.webp`, creator: "Artist Name", license: "CC BY 4.0",
    filePage: "https://commons.wikimedia.org/wiki/File:Example.webp" };
  const artwork = selectApprovedArtwork(id, { [id]: entry });
  assert.equal(artwork.creator, "Artist Name");
  assert.equal(artwork.licenseUrl, "https://creativecommons.org/licenses/by/4.0/");
  assert.equal(selectApprovedArtwork(id, { [id]: { ...entry, path: "https://evil.example/poster.webp" } }), null);
  assert.equal(selectApprovedArtwork(id, { [id]: { ...entry, license: "Unknown" } }), null);
  assert.equal(selectApprovedArtwork(id, { [id]: { ...entry, creator: "" } }), null);
  assert.equal(selectApprovedArtwork(`movie_${"b".repeat(20)}`, { [id]: entry }), null);
});

test("cursor pagination is bounded, stable, exact-genre filtered and complete", () => {
  const rows = [row, { ...row, id: `movie_${"b".repeat(20)}`, title: "B", genre: "comedy" },
    { ...row, id: `movie_${"c".repeat(20)}`, title: "C", genre: "drama" }];
  const catalogue = makeCatalogue(rows.reverse());
  const first = browseCatalogue(catalogue, { limit: 2 });
  assert.deepEqual(first.items.map((movie) => movie.id), [id, `movie_${"b".repeat(20)}`]);
  assert.equal(first.nextCursor, `movie_${"b".repeat(20)}`);
  const next = browseCatalogue(catalogue, { limit: 2, after: first.nextCursor });
  assert.deepEqual(next.items.map((movie) => movie.id), [`movie_${"c".repeat(20)}`]);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(browseCatalogue(catalogue, { genre: "drama" }).items.map((movie) => movie.id), [id, `movie_${"c".repeat(20)}`]);
  assert.equal(getCatalogueMovie(catalogue, id)?.title, "A Real Film");
  assert.equal(getCatalogueMovie(catalogue, "bad"), null);
  assert.throws(() => browseCatalogue(catalogue, { limit: 25 }));
  assert.throws(() => browseCatalogue(catalogue, { after: `movie_${"f".repeat(20)}` }));
  assert.throws(() => makeCatalogue([row, row]));
});

test("read-only browse and detail handlers expose no plot or internal metadata", async () => {
  const catalogue = makeCatalogue([row]);
  const browse = createBrowseHandler(async () => catalogue);
  const detail = createDetailHandler(async () => catalogue);
  const good = await browse(new Request("https://example.test/api/movies?genre=drama&limit=1"));
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.doesNotMatch(await good.text(), /unlicensed plot|content_hash|\$vector/u);
  assert.equal((await browse(new Request("https://example.test/api/movies?limit=999"))).status, 400);
  assert.equal((await browse(new Request("https://example.test/api/movies?genre=drama&genre=crime"))).status, 400);
  const found = await detail(new Request("https://example.test/api/movies/abc"), { params: Promise.resolve({ id }) });
  assert.equal(found.status, 200);
  assert.doesNotMatch(await found.text(), /unlicensed plot|content_hash|\$vector/u);
  assert.equal((await detail(null, { params: Promise.resolve({ id: "bad" }) })).status, 404);
});

test("all 1,100 source IDs are available in deterministic read-only catalogue pages", async () => {
  const source = await readUnifiedMovies();
  const catalogue = makeCatalogue(source);
  assert.equal(catalogue.length, 1100);
  const seen = new Set();
  let after = "";
  do {
    const page = browseCatalogue(catalogue, { after, limit: 24 });
    for (const movie of page.items) {
      assert.equal(seen.has(movie.id), false);
      assert.equal(movie.artwork, null);
      seen.add(movie.id);
    }
    after = page.nextCursor ?? "";
    if (!page.nextCursor) break;
  } while (true);
  assert.equal(seen.size, 1100);
  assert.equal(source.filter((movie) => movie.genre === "").length, 1);
});
