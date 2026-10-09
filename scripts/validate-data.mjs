import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import {
  MAX_MOVIES, MOVIE_COLUMNS, canonicalSourceUrl, decade, genreGroup,
  movieId, normalizeWhitespace, sourceArticleKey, sourceMovieId,
  strictUtf8, validPlot, validYear,
} from "./movie-data.mjs";

const INPUT_PATH = resolve(process.argv[2] ?? "data/movies.csv");
const IS_RECENT = basename(INPUT_PATH) === "recent-movies.csv";
const IS_ALL = basename(INPUT_PATH) === "all-movies.csv";

function sortedCounts(counts) {
  return Object.fromEntries([...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

async function scanCsv(path, onRow) {
  const parser = csv({ strict: true });
  let headerSeen = false;
  let count = 0;
  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((name, index) => name !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error("Expected CSV columns: " + MOVIE_COLUMNS.join(",") + "."));
    }
  });
  await pipeline(createReadStream(path), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      count += 1;
      await onRow(row, count);
    }
  });
  if (!headerSeen || count === 0) throw new Error("Movie CSV is empty.");
  return count;
}

async function verifyAllCoverage(outputByArticle) {
  const variants = new Map();
  const counts = {};
  for (const [dataset, path] of [
    ["historical", resolve("data/movies.csv")],
    ["recent", resolve("data/recent-movies.csv")],
  ]) {
    counts[dataset] = await scanCsv(path, (row) => {
      const movie = Object.fromEntries(MOVIE_COLUMNS.map((column) => [column, normalizeWhitespace(row[column])]));
      const key = sourceArticleKey(movie.source_url);
      if (!key) throw new Error(dataset + " input has an invalid source URL.");
      const group = variants.get(key) ?? [];
      group.push(movie);
      variants.set(key, group);
    });
  }
  if (outputByArticle.size !== variants.size) {
    throw new Error("Unified output does not cover every input article identity.");
  }
  for (const [key, sourceRecords] of variants) {
    const output = outputByArticle.get(key);
    if (!output) throw new Error("Unified output is missing an input article.");
    if (!sourceRecords.some((source) =>
      ["title", "year", "genre", "plot", "source_url"].every((field) => output[field] === source[field])
    )) {
      throw new Error("Unified output changed or truncated an input movie record.");
    }
  }
  return {
    ...counts,
    uniqueSourceArticles: variants.size,
    duplicatesRemoved: counts.historical + counts.recent - variants.size,
  };
}

async function validate() {
  const seenIds = new Set();
  const seenArticles = new Set();
  const outputByArticle = new Map();
  const plotLengths = [];
  const decades = new Map();
  const years = new Map();
  const genres = new Map();

  const count = await scanCsv(INPUT_PATH, (row, number) => {
    if (!IS_ALL && number > MAX_MOVIES) throw new Error("Movie count exceeds " + MAX_MOVIES + ".");
    const movie = Object.fromEntries(MOVIE_COLUMNS.map((column) => [column, normalizeWhitespace(row[column])]));
    if (!movie.id || !movie.title || !movie.plot) {
      throw new Error("Row " + number + ": id, title, and plot are required.");
    }
    if (!validPlot(movie.plot)) throw new Error("Row " + number + ": plot is too short.");
    if (!validYear(movie.year)) throw new Error("Row " + number + ": release year is invalid.");
    if (IS_RECENT && (!movie.year || Number(movie.year) < 2019 || Number(movie.year) > 2026)) {
      throw new Error("Row " + number + ": recent movie year must be 2019-2026.");
    }
    if (IS_RECENT && !movie.genre) throw new Error("Row " + number + ": genre is required for recent movies.");
    if (!movie.source_url || canonicalSourceUrl(movie.source_url) !== movie.source_url) {
      throw new Error("Row " + number + ": source URL is invalid.");
    }
    const article = sourceArticleKey(movie.source_url);
    if (!article) throw new Error("Row " + number + ": source article identity is invalid.");
    if (seenIds.has(movie.id)) throw new Error("Row " + number + ": duplicate movie ID.");
    if (movie.id !== movieId(movie) && movie.id !== sourceMovieId(movie)) {
      throw new Error("Row " + number + ": movie ID is not stable for its identity.");
    }
    if (seenArticles.has(article)) {
      throw new Error("Row " + number + ": duplicate movie identity.");
    }
    seenIds.add(movie.id);
    seenArticles.add(article);
    if (IS_ALL) outputByArticle.set(article, movie);

    plotLengths.push([...movie.plot].length);
    const decadeKey = decade(movie);
    const genreKey = genreGroup(movie.genre);
    if (movie.year) years.set(movie.year, (years.get(movie.year) ?? 0) + 1);
    decades.set(decadeKey, (decades.get(decadeKey) ?? 0) + 1);
    genres.set(genreKey, (genres.get(genreKey) ?? 0) + 1);
  });

  const coverage = IS_ALL ? await verifyAllCoverage(outputByArticle) : undefined;
  plotLengths.sort((a, b) => a - b);
  const sum = plotLengths.reduce((total, length) => total + length, 0);
  console.log(JSON.stringify({
    result: "PASS",
    records: count,
    plotCharacters: {
      min: plotLengths[0],
      median: plotLengths[Math.floor((count - 1) / 2)],
      mean: Math.round(sum / count),
      max: plotLengths[count - 1],
    },
    byDecade: sortedCounts(decades),
    ...(IS_RECENT || IS_ALL ? { byYear: sortedCounts(years) } : {}),
    byGenreGroup: sortedCounts(genres),
    ...(coverage ? { coverage } : {}),
  }, null, 2));
}

try {
  await validate();
} catch (error) {
  console.error("Dataset validation failed: " + error.message);
  process.exitCode = 1;
}
