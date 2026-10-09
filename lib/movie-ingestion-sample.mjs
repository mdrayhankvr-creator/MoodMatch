import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import { MOVIE_COLUMNS, strictUtf8 } from "../scripts/movie-data.mjs";
import { buildMovieEmbeddingInput } from "./embedding-runtime.mjs";
import { LOCAL_MAX_TOKENS } from "./embedding-provider.mjs";

export async function readUnifiedMovies(file = resolve("data/all-movies.csv")) {
  const movies = [];
  const ids = new Set();
  let headerSeen = false;
  const parser = csv({ strict: true });
  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((field, index) => field !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error("Unified movie CSV schema is invalid."));
    }
  });
  await pipeline(createReadStream(file), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      if (!row.id || !row.title || !row.plot || !row.source_url || ids.has(row.id)) {
        throw new Error("Unified movie CSV has a missing field or duplicate ID.");
      }
      ids.add(row.id);
      movies.push(row);
    }
  });
  if (!headerSeen || movies.length === 0) throw new Error("Unified movie CSV is empty.");
  return movies;
}

function byRank(left, right) {
  const a = createHash("sha256").update(left.id).digest("hex");
  const b = createHash("sha256").update(right.id).digest("hex");
  return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
}

export async function selectMovieSample(movies, provider, limit = 5) {
  if (!Number.isSafeInteger(limit) || limit < 2 || limit > 5 || provider.id !== "local") {
    throw new Error("Local sample limit must be 2..5.");
  }
  const counts = await provider.tokenCounts(movies.map(buildMovieEmbeddingInput));
  if (!Array.isArray(counts) || counts.length !== movies.length) throw new Error("Tokenizer returned incomplete counts.");
  const long = movies.filter((_, index) => counts[index] > LOCAL_MAX_TOKENS).sort(byRank);
  const short = movies.filter((_, index) => counts[index] <= LOCAL_MAX_TOKENS).sort(byRank);
  if (long.length < 2 || short.length < limit - 2) throw new Error("Insufficient real movies for sample.");
  return [...long.slice(0, 2), ...short.slice(0, limit - 2)];
}
