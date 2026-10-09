import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import csv from "csv-parser";
import {
  MOVIE_COLUMNS, canonicalSourceUrl, csvField, genreGroup, movieId,
  normalizeWhitespace, sourceArticleKey, sourceMovieId, strictUtf8,
  validPlot, validYear,
} from "./movie-data.mjs";

const HISTORICAL_PATH = resolve("data/movies.csv");
const RECENT_PATH = resolve("data/recent-movies.csv");
const OUTPUT_PATH = resolve("data/all-movies.csv");
const REPORT_PATH = resolve("data/DATASET_REPORT.md");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function titleYearKey(movie) {
  return movie.title.normalize("NFKC").toLowerCase() + "\0" + movie.year;
}

function validateInput(row, dataset, rowNumber) {
  const movie = Object.fromEntries(MOVIE_COLUMNS.map((column) => [column, normalizeWhitespace(row[column])]));
  const prefix = dataset + " row " + rowNumber + ": ";
  if (!movie.id || !movie.title || !movie.plot || !movie.source_url) {
    throw new Error(prefix + "id, title, plot, and source_url are required.");
  }
  if (!validPlot(movie.plot)) throw new Error(prefix + "plot is too short.");
  if (!validYear(movie.year)) throw new Error(prefix + "release year is invalid.");
  if (canonicalSourceUrl(movie.source_url) !== movie.source_url || !sourceArticleKey(movie.source_url)) {
    throw new Error(prefix + "source article URL is invalid.");
  }
  if (movie.id !== movieId(movie) && movie.id !== sourceMovieId(movie)) {
    throw new Error(prefix + "input movie ID is invalid.");
  }
  if (dataset === "recent" && (!movie.year || !movie.genre || Number(movie.year) < 2019 || Number(movie.year) > 2026)) {
    throw new Error(prefix + "recent year or genre is invalid.");
  }
  return movie;
}

async function readInput(path, dataset, groups) {
  const parser = csv({ strict: true });
  let headerSeen = false;
  let count = 0;
  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((name, index) => name !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error(dataset + " CSV columns do not match the movie schema."));
    }
  });
  await pipeline(createReadStream(path), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      count += 1;
      const movie = validateInput(row, dataset, count);
      const key = sourceArticleKey(movie.source_url);
      const group = groups.get(key) ?? [];
      group.push({ movie, dataset });
      groups.set(key, group);
    }
  });
  if (!headerSeen || count === 0) throw new Error(dataset + " CSV is empty.");
  return count;
}

export function compareQuality(left, right) {
  const a = left.movie;
  const b = right.movie;
  const aComplete = Number(Boolean(a.year)) + Number(Boolean(a.genre));
  const bComplete = Number(Boolean(b.year)) + Number(Boolean(b.genre));
  if (aComplete !== bComplete) return bComplete - aComplete;

  // Quarter-octave length bands give a total, deterministic quality ordering.
  // Records in the same band have equivalent plot coverage.
  const aLength = [...a.plot].length;
  const bLength = [...b.plot].length;
  const aTier = Math.floor(Math.log2(aLength / 120) * 4);
  const bTier = Math.floor(Math.log2(bLength / 120) * 4);
  if (aTier !== bTier) return bTier - aTier;
  if (left.dataset !== right.dataset) return left.dataset === "recent" ? -1 : 1;
  if (aLength !== bLength) return bLength - aLength;
  const aFields = MOVIE_COLUMNS.map((column) => a[column]).join("\0");
  const bFields = MOVIE_COLUMNS.map((column) => b[column]).join("\0");
  return compareText(aFields, bFields);
}

export function merge(groups) {
  const winners = [];
  let duplicateRecordsRemoved = 0;
  let crossDatasetDuplicateGroups = 0;
  for (const group of groups.values()) {
    const releaseYears = new Set(group.map(({ movie }) => movie.year).filter(Boolean));
    if (releaseYears.size > 1) {
      throw new Error("One source article has conflicting release years; review the input records.");
    }
    duplicateRecordsRemoved += group.length - 1;
    if (new Set(group.map((record) => record.dataset)).size > 1) crossDatasetDuplicateGroups += 1;
    winners.push([...group].sort(compareQuality)[0]);
  }

  const titleGroups = new Map();
  const idCounts = new Map();
  for (const record of winners) {
    const titleKey = titleYearKey(record.movie);
    titleGroups.set(titleKey, (titleGroups.get(titleKey) ?? 0) + 1);
    idCounts.set(record.movie.id, (idCounts.get(record.movie.id) ?? 0) + 1);
  }
  const distinctSameTitleYear = [...titleGroups.values()].reduce((sum, size) => sum + Math.max(0, size - 1), 0);
  let sourceAnchoredIds = 0;
  const seenIds = new Set();
  const movies = winners.map(({ movie }) => {
    const id = idCounts.get(movie.id) > 1 ? sourceMovieId(movie) : movie.id;
    if (id !== movie.id) sourceAnchoredIds += 1;
    if (seenIds.has(id)) throw new Error("Movie ID collision after source-based disambiguation.");
    seenIds.add(id);
    return { ...movie, id };
  });
  movies.sort((a, b) =>
    Number(a.year || 0) - Number(b.year || 0) ||
    compareText(a.title, b.title) ||
    compareText(sourceArticleKey(a.source_url), sourceArticleKey(b.source_url))
  );
  return { movies, duplicateRecordsRemoved, crossDatasetDuplicateGroups, distinctSameTitleYear, sourceAnchoredIds };
}

function distribution(movies) {
  const years = new Map();
  const genres = new Map();
  const lengths = [];
  for (const movie of movies) {
    const year = movie.year || "unknown";
    const genre = genreGroup(movie.genre);
    years.set(year, (years.get(year) ?? 0) + 1);
    genres.set(genre, (genres.get(genre) ?? 0) + 1);
    lengths.push([...movie.plot].length);
  }
  lengths.sort((a, b) => a - b);
  return {
    years, genres,
    plot: {
      min: lengths[0],
      median: lengths[Math.floor((lengths.length - 1) / 2)],
      mean: Math.round(lengths.reduce((sum, length) => sum + length, 0) / lengths.length),
      max: lengths.at(-1),
    },
  };
}

function yearTable(years) {
  const decades = new Map();
  for (const [year, count] of [...years].sort(([a], [b]) => compareText(a, b))) {
    const decade = year === "unknown" ? "unknown" : String(Math.floor(Number(year) / 10) * 10) + "s";
    const group = decades.get(decade) ?? [];
    group.push([year, count]);
    decades.set(decade, group);
  }
  return [
    "| Decade | Year: count | Total |",
    "| --- | --- | ---: |",
    ...[...decades].map(([decade, entries]) =>
      "| " + decade + " | " + entries.map(([year, count]) => year + ": " + count).join(", ") +
      " | " + entries.reduce((sum, [, count]) => sum + count, 0) + " |"
    ),
  ];
}

function report(stats, counts, hashes, metrics) {
  const tick = String.fromCharCode(96);
  const genres = [...metrics.genres].sort(([a, aCount], [b, bCount]) =>
    bCount - aCount || compareText(a, b)
  ).map(([genre, count]) => "| " + genre + " | " + count + " |");
  return [
    "# Unified movie dataset report",
    "",
    "Generated by " + tick + "npm run data" + tick + " from the two validated CSV inputs.",
    "",
    "## Counts",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    "| Historical input | " + counts.historical + " |",
    "| Recent input | " + counts.recent + " |",
    "| Unique merged movies | " + stats.movies.length + " |",
    "| Duplicate records removed | " + stats.duplicateRecordsRemoved + " |",
    "| Cross-dataset duplicate article groups | " + stats.crossDatasetDuplicateGroups + " |",
    "| Same title and year, distinct articles retained | " + stats.distinctSameTitleYear + " |",
    "| Source-anchored IDs assigned for collisions | " + stats.sourceAnchoredIds + " |",
    "",
    "A duplicate means the same normalized Wikipedia article identity. Movies with identical",
    "titles and years but different article identities remain separate. All surviving fields",
    "come from one complete input record; plots are only whitespace-normalized.",
    "For duplicate articles, populated metadata and a higher plot-length quality band win;",
    "the verified recent record wins within the same band. Remaining ties use stable text order.",
    "Conflicting release years for one article stop the merge for manual review.",
    "",
    "## Year distribution",
    "",
    ...yearTable(metrics.years),
    "",
    "## Genre distribution",
    "",
    "Groups use the first source genre label for counting; the CSV retains the original genre text.",
    "",
    "| Genre group | Movies |",
    "| --- | ---: |",
    ...genres,
    "",
    "## Plot length",
    "",
    "Unicode characters after whitespace normalization: minimum " + metrics.plot.min +
      ", median " + metrics.plot.median + ", mean " + metrics.plot.mean + ", maximum " + metrics.plot.max + ".",
    "No selected plot is shortened or rewritten.",
    "",
    "## Source fingerprints",
    "",
    "- " + tick + "data/movies.csv" + tick + " SHA-256: " + tick + hashes.historical + tick,
    "- " + tick + "data/recent-movies.csv" + tick + " SHA-256: " + tick + hashes.recent + tick,
    "- " + tick + "data/all-movies.csv" + tick + " SHA-256: " + tick + hashes.all + tick,
    "",
    "## Attribution and limitations",
    "",
    "Every row retains its Wikipedia article URL. See [ATTRIBUTION.md](ATTRIBUTION.md) for",
    "Wikipedia contributor credit, CC BY-SA 4.0 obligations, Wikidata CC0 metadata,",
    "modification notices, and possible article-specific imported-text attribution.",
    "The historical source is a selected 2018 Kaggle snapshot; recent articles are a",
    "deterministic sample of Wikipedia film categories as of the documented acquisition.",
    "The year 2018 and some other years are absent from the supplied inputs. Genre labels",
    "are not a controlled taxonomy, and one historical movie has no genre label.",
    "Offline article identity uses normalized URLs; distinct redirect aliases may remain.",
    "Source articles can change after acquisition; regenerate inputs deliberately before",
    "rebuilding this file.",
    "",
  ].join("\n");
}

async function writeIfChanged(path, content) {
  try {
    if (await readFile(path, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporaryPath = path + "." + process.pid + ".tmp";
  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function main() {
  const groups = new Map();
  const historical = await readInput(HISTORICAL_PATH, "historical", groups);
  const recent = await readInput(RECENT_PATH, "recent", groups);
  const stats = merge(groups);
  if (stats.movies.length !== historical + recent - stats.duplicateRecordsRemoved) {
    throw new Error("Merged count does not reconcile with input counts.");
  }
  const csvText = [
    MOVIE_COLUMNS.join(","),
    ...stats.movies.map((movie) => MOVIE_COLUMNS.map((column) => csvField(movie[column])).join(",")),
  ].join("\n") + "\n";
  const hashes = {
    historical: sha256(await readFile(HISTORICAL_PATH)),
    recent: sha256(await readFile(RECENT_PATH)),
    all: sha256(Buffer.from(csvText, "utf8")),
  };
  const metrics = distribution(stats.movies);
  await writeIfChanged(OUTPUT_PATH, csvText);
  await writeIfChanged(REPORT_PATH, report(stats, { historical, recent }, hashes, metrics));
  console.log(JSON.stringify({
    historical,
    recent,
    uniqueMerged: stats.movies.length,
    duplicatesRemoved: stats.duplicateRecordsRemoved,
    crossDatasetDuplicateGroups: stats.crossDatasetDuplicateGroups,
    distinctSameTitleYear: stats.distinctSameTitleYear,
    sourceAnchoredIds: stats.sourceAnchoredIds,
    byYear: Object.fromEntries([...metrics.years].sort(([a], [b]) => compareText(a, b))),
    byGenreGroup: Object.fromEntries([...metrics.genres].sort(([a], [b]) => compareText(a, b))),
    plotCharacters: metrics.plot,
    sha256: hashes.all,
  }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error("Unified dataset merge failed: " + error.message);
    process.exitCode = 1;
  }
}
