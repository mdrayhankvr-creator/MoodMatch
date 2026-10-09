import { createReadStream } from "node:fs";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import {
  MAX_MOVIES,
  MOVIE_COLUMNS,
  canonicalSourceUrl,
  decade,
  genreGroup,
  identityKey,
  movieId,
  normalizeWhitespace,
  strictUtf8,
  validPlot,
  validYear,
} from "./movie-data.mjs";

const INPUT_PATH = resolve(process.argv[2] ?? "data/movies.csv");
const IS_RECENT = basename(INPUT_PATH) === "recent-movies.csv";

function sortedCounts(counts) {
  return Object.fromEntries([...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

async function validate() {
  const seenIds = new Set();
  const seenIdentity = new Set();
  const seenUrls = new Set();
  const plotLengths = [];
  const decades = new Map();
  const years = new Map();
  const genres = new Map();
  const parser = csv({ strict: true });
  let headerSeen = false;
  let count = 0;

  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((name, index) => name !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error(`Expected CSV columns: ${MOVIE_COLUMNS.join(",")}.`));
    }
  });

  await pipeline(createReadStream(INPUT_PATH), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      count += 1;
      if (count > MAX_MOVIES) throw new Error(`Movie count exceeds ${MAX_MOVIES}.`);

      const movie = Object.fromEntries(MOVIE_COLUMNS.map((column) => [column, normalizeWhitespace(row[column])]));
      if (!movie.id || !movie.title || !movie.plot) {
        throw new Error(`Row ${count}: id, title, and plot are required.`);
      }
      if (!validPlot(movie.plot)) throw new Error(`Row ${count}: plot is too short.`);
      if (!validYear(movie.year)) throw new Error(`Row ${count}: release year is invalid.`);
      if (IS_RECENT && (!movie.year || Number(movie.year) < 2019 || Number(movie.year) > 2026)) {
        throw new Error(`Row ${count}: recent movie year must be 2019–2026.`);
      }
      if (IS_RECENT && !movie.genre) throw new Error(`Row ${count}: genre is required for recent movies.`);
      if (!movie.source_url || canonicalSourceUrl(movie.source_url) !== movie.source_url) {
        throw new Error(`Row ${count}: source URL is invalid.`);
      }
      if (seenIds.has(movie.id)) throw new Error(`Row ${count}: duplicate movie ID.`);
      if (movie.id !== movieId(movie)) throw new Error(`Row ${count}: movie ID is not stable for its identity.`);

      const identity = identityKey(movie);
      if (seenIdentity.has(identity) || seenUrls.has(movie.source_url)) {
        throw new Error(`Row ${count}: duplicate movie identity.`);
      }
      seenIds.add(movie.id);
      seenIdentity.add(identity);
      seenUrls.add(movie.source_url);

      plotLengths.push([...movie.plot].length);
      const decadeKey = decade(movie);
      const genreKey = genreGroup(movie.genre);
      if (movie.year) years.set(movie.year, (years.get(movie.year) ?? 0) + 1);
      decades.set(decadeKey, (decades.get(decadeKey) ?? 0) + 1);
      genres.set(genreKey, (genres.get(genreKey) ?? 0) + 1);
    }
  });

  if (!headerSeen || count === 0) throw new Error("Movie CSV is empty.");
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
    ...(IS_RECENT ? { byYear: sortedCounts(years) } : {}),
    byGenreGroup: sortedCounts(genres),
  }, null, 2));
}

try {
  await validate();
} catch (error) {
  console.error(`Dataset validation failed: ${error.message}`);
  process.exitCode = 1;
}
