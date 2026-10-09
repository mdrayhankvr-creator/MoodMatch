import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import {
  MAX_MOVIES,
  MOVIE_COLUMNS,
  canonicalSourceUrl,
  csvField,
  decade,
  genreGroup,
  identityKey,
  movieId,
  normalizeWhitespace,
  strictUtf8,
  validPlot,
  validYear,
} from "./movie-data.mjs";

const RAW_PATH = resolve(process.argv[2] ?? "data/raw/wiki_movie_plots_deduped.csv");
const OUTPUT_PATH = resolve("data/movies.csv");
const BUCKET_LIMIT = 40;
const REQUIRED_SOURCE_COLUMNS = ["Release Year", "Title", "Genre", "Wiki Page", "Plot"];

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function keepCandidate(buckets, movie) {
  const key = `${decade(movie)}\0${genreGroup(movie.genre)}`;
  const bucket = buckets.get(key) ?? [];
  bucket.push(movie);
  bucket.sort((a, b) => compareText(a.score, b.score) || compareText(a.id, b.id));
  if (bucket.length > BUCKET_LIMIT) bucket.pop();
  buckets.set(key, bucket);
}

function selectMovies(buckets) {
  const candidates = [...buckets.values()].flat();
  candidates.sort((a, b) => compareText(a.score, b.score) || compareText(a.id, b.id));

  const selected = [];
  const selectedIds = new Set();
  const decades = new Map();
  const genres = new Map();

  // A second, still bounded pass fills sparse strata without letting one group dominate.
  for (const limits of [{ decade: 180, genre: 250 }, { decade: 230, genre: 300 }]) {
    for (const movie of candidates) {
      if (selected.length === MAX_MOVIES) break;
      if (selectedIds.has(movie.id)) continue;

      const decadeKey = decade(movie);
      const genreKey = genreGroup(movie.genre);
      if ((decades.get(decadeKey) ?? 0) >= limits.decade) continue;
      if ((genres.get(genreKey) ?? 0) >= limits.genre) continue;

      selected.push(movie);
      selectedIds.add(movie.id);
      decades.set(decadeKey, (decades.get(decadeKey) ?? 0) + 1);
      genres.set(genreKey, (genres.get(genreKey) ?? 0) + 1);
    }
    if (selected.length === MAX_MOVIES) break;
  }

  selected.sort((a, b) =>
    compareText(a.year, b.year) ||
    compareText(a.title, b.title) ||
    compareText(a.id, b.id)
  );
  return selected;
}

async function prepare() {
  const counts = {
    raw: 0,
    missingTitleOrPlot: 0,
    shortPlot: 0,
    invalidYear: 0,
    invalidSourceUrl: 0,
    duplicates: 0,
    validUnique: 0,
    selected: 0,
  };
  const seenIdentity = new Set();
  const seenUrls = new Set();
  const buckets = new Map();
  const parser = csv({
    strict: true,
    mapHeaders: ({ header }) => header.replace(/^\uFEFF/u, "").trim(),
  });

  parser.once("headers", (headers) => {
    const missing = REQUIRED_SOURCE_COLUMNS.filter((column) => !headers.includes(column));
    if (missing.length || new Set(headers).size !== headers.length) {
      parser.destroy(new Error(`Source CSV headers are invalid; missing: ${missing.join(", ") || "none"}.`));
    }
  });

  await pipeline(createReadStream(RAW_PATH), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      counts.raw += 1;
      const title = normalizeWhitespace(row.Title);
      const plot = normalizeWhitespace(row.Plot);
      const year = normalizeWhitespace(row["Release Year"]);
      const genre = normalizeWhitespace(row.Genre);
      const source_url = canonicalSourceUrl(row["Wiki Page"]);

      if (!title || !plot) {
        counts.missingTitleOrPlot += 1;
        continue;
      }
      if (!validPlot(plot)) {
        counts.shortPlot += 1;
        continue;
      }
      if (!validYear(year)) {
        counts.invalidYear += 1;
        continue;
      }
      // Every selected plot keeps an article link for source attribution.
      if (!source_url) {
        counts.invalidSourceUrl += 1;
        continue;
      }

      const movie = { title, year, genre, plot, source_url };
      const identity = identityKey(movie);
      if (seenIdentity.has(identity) || seenUrls.has(source_url)) {
        counts.duplicates += 1;
        continue;
      }
      seenIdentity.add(identity);
      seenUrls.add(source_url);
      counts.validUnique += 1;

      movie.id = movieId(movie);
      movie.score = createHash("sha256").update(`sample:\0${identity}`).digest("hex");
      keepCandidate(buckets, movie);
    }
  });

  const selected = selectMovies(buckets);
  if (selected.length === 0) throw new Error("No valid movie records were found.");
  counts.selected = selected.length;

  const lines = [
    MOVIE_COLUMNS.join(","),
    ...selected.map((movie) => MOVIE_COLUMNS.map((column) => csvField(movie[column])).join(",")),
  ];
  const temporaryPath = resolve("data", `.movies.csv.tmp-${process.pid}`);
  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  try {
    await writeFile(temporaryPath, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, OUTPUT_PATH);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  console.log(JSON.stringify(counts, null, 2));
}

try {
  await prepare();
} catch (error) {
  console.error(`Dataset preparation failed: ${error.message}`);
  process.exitCode = 1;
}
