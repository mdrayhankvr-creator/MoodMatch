import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import { chunkDescription } from "../lib/chunking.mjs";
import { createEmbeddingProvider, LOCAL_DIMENSIONS, LOCAL_MAX_TOKENS } from "../lib/embedding-provider.mjs";
import { embedMovieLocally } from "../lib/movie-embeddings.mjs";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { MOVIE_COLUMNS, strictUtf8 } from "./movie-data.mjs";

function parseArgs(args) {
  const mode = args[0];
  if (mode === "--dry-run" && args.length === 1) return { mode, limit: 0 };
  if (mode === "--sample" && args.length === 1) return { mode, limit: 5 };
  if (mode === "--sample" && args.length === 3 && args[1] === "--limit" && /^[2-5]$/u.test(args[2])) {
    return { mode, limit: Number(args[2]) };
  }
  throw new Error("Use --dry-run or --sample [--limit 2..5]. Full-dataset inference is disabled.");
}

async function readMovies() {
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
  await pipeline(createReadStream(resolve("data/all-movies.csv")), strictUtf8(), parser, async (rows) => {
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

function rank(movie) {
  return createHash("sha256").update(movie.id).digest("hex");
}

function byRank(left, right) {
  const a = rank(left);
  const b = rank(right);
  return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

async function main() {
  const { mode, limit } = parseArgs(process.argv.slice(2));
  const movies = await readMovies();
  const provider = createEmbeddingProvider({ providerId: "local" });

  if (mode === "--dry-run") {
    let totalChunks = 0;
    let longInputs = 0;
    let maxObservedTokens = 0;
    for (const movie of movies) {
      const plan = await chunkDescription({ title: movie.title, genre: movie.genre,
        description: movie.plot }, provider.tokenCounts);
      totalChunks += plan.chunks.length;
      if (plan.chunks.length > 1) longInputs += 1;
      for (const chunk of plan.chunks) {
        if (chunk.inputTokens > LOCAL_MAX_TOKENS) throw new Error("Chunk exceeds the local token limit.");
        maxObservedTokens = Math.max(maxObservedTokens, chunk.inputTokens);
      }
    }
    console.log(JSON.stringify({ mode: "dry-run", moviesAnalyzed: movies.length, longInputs,
      totalChunks, maxObservedTokens, modelTokenLimit: LOCAL_MAX_TOKENS,
      inferenceCalls: 0, vectorsWritten: 0 }, null, 2));
    return;
  }

  const counts = await provider.tokenCounts(movies.map(buildMovieEmbeddingInput));
  if (counts.length !== movies.length) throw new Error("Tokenizer returned incomplete movie counts.");
  const long = movies.filter((_, index) => counts[index] > LOCAL_MAX_TOKENS).sort(byRank);
  const short = movies.filter((_, index) => counts[index] <= LOCAL_MAX_TOKENS).sort(byRank);
  if (long.length < 2 || short.length < limit - 2) throw new Error("Insufficient real movies for the required sample.");
  const sample = [...long.slice(0, 2), ...short.slice(0, limit - 2)];
  const results = [];
  for (const movie of sample) {
    const result = await embedMovieLocally(movie, provider);
    const norm = Math.hypot(...result.vector);
    if (result.vector.length !== LOCAL_DIMENSIONS || !Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
      throw new Error(`Movie ${movie.id} produced an invalid aggregate vector.`);
    }
    results.push({ id: movie.id, chunks: result.chunkCount, dimensions: result.vector.length,
      l2Norm: Number(norm.toFixed(6)), cache: result.cacheStatus, inferenceCalls: result.inferenceCalls });
  }
  console.log(JSON.stringify({ mode: "sample", moviesAnalyzed: movies.length, sampleSize: results.length,
    cacheHits: results.filter((item) => item.cache === "hit").length,
    cacheMisses: results.filter((item) => item.cache === "miss").length,
    cacheRepairs: results.filter((item) => item.cache === "repaired").length,
    inferenceCalls: results.reduce((sum, item) => sum + item.inferenceCalls, 0),
    results }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error("Local embedding build failed: " + error.message);
  process.exitCode = 1;
}
