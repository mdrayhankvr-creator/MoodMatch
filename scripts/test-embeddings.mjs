import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import dotenv from "dotenv";
import {
  EMBEDDING_DIMENSIONS, MAX_INPUT_TOKENS,
  buildMovieEmbeddingInput, embedTexts, getEmbeddingModel, tokenUpperBound,
} from "../lib/embedding-runtime.mjs";
import { MOVIE_COLUMNS, strictUtf8 } from "./movie-data.mjs";

function options(args) {
  let limit;
  let live = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--live" && !live) live = true;
    else if (arg === "--limit" && limit === undefined && /^\d+$/u.test(args[index + 1] ?? "")) {
      limit = Number(args[++index]);
    } else throw new Error("Use --limit 1..5 and optionally --live. Full-dataset requests are disabled.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 5) {
    throw new Error("--limit must be an integer from 1 to 5. Full-dataset requests are disabled.");
  }
  return { limit, live };
}

async function sampleMovies(limit) {
  const candidates = [];
  let excludedBySafetyBound = 0;
  const parser = csv({ strict: true });
  let headerSeen = false;
  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((name, index) => name !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error("Unified movie CSV schema is invalid."));
    }
  });
  await pipeline(createReadStream(resolve("data/all-movies.csv")), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      if (!row.id || !row.title || !row.plot || !row.source_url) throw new Error("Unified CSV has a missing required movie field.");
      const text = buildMovieEmbeddingInput(row);
      const tokenCeiling = tokenUpperBound(text);
      if (tokenCeiling > MAX_INPUT_TOKENS) {
        excludedBySafetyBound += 1;
        continue;
      }
      candidates.push({
        id: row.id,
        title: row.title,
        text,
        tokenCeiling,
        sampleKey: createHash("sha256").update(row.id).digest("hex"),
      });
    }
  });
  if (!headerSeen) throw new Error("Unified movie CSV is empty.");
  candidates.sort((left, right) =>
    (left.sampleKey < right.sampleKey ? -1 : left.sampleKey > right.sampleKey ? 1 : 0) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
  if (candidates.length < limit) throw new Error("There are fewer eligible movies than the requested sample size.");
  return { movies: candidates.slice(0, limit), excludedBySafetyBound };
}

async function main() {
  const { limit, live } = options(process.argv.slice(2));
  dotenv.config({ path: resolve(".env.local"), override: false, quiet: true });
  const model = getEmbeddingModel();
  const { movies, excludedBySafetyBound } = await sampleMovies(limit);
  const tokenCeiling = movies.reduce((sum, movie) => sum + movie.tokenCeiling, 0);
  if (!live) {
    console.log(JSON.stringify({
      mode: "dry-run",
      model,
      plannedCalls: 1,
      sampleSize: movies.length,
      conservativeTokenCeiling: tokenCeiling,
      excludedBySafetyBound,
      movies: movies.map(({ id, title, tokenCeiling: ceiling }) => ({
        id, title, plannedDimensions: EMBEDDING_DIMENSIONS, conservativeTokenCeiling: ceiling,
      })),
    }, null, 2));
    return;
  }
  const response = await embedTexts(movies.map(({ text }) => text));
  console.log(JSON.stringify({
    mode: "live",
    model: response.model,
    inputTokens: response.inputTokens,
    movies: movies.map(({ id, title }, index) => ({
      id, title, dimensions: response.embeddings[index].length,
    })),
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error("Embedding test failed: " + error.message);
  process.exitCode = 1;
}
