import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import dotenv from "dotenv";
import {
  LOCAL_DIMENSIONS, createEmbeddingProvider, validateEmbeddingVectors,
} from "../lib/embedding-provider.mjs";
import { analyzeLocalMovieInputs, writeLocalInputReport } from "./local-movie-inputs.mjs";

function parseLimit(args) {
  if (args.length === 0) return 5;
  if (args.length !== 2 || args[0] !== "--limit" || !/^[1-5]$/u.test(args[1])) {
    throw new Error("Use --limit 1..5. Full-dataset inference is disabled.");
  }
  return Number(args[1]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function main() {
  const limit = parseLimit(process.argv.slice(2));
  dotenv.config({ path: resolve(".env.local"), override: false, quiet: true });
  const provider = createEmbeddingProvider({ providerId: "local" });
  const analysis = await analyzeLocalMovieInputs(provider);
  await writeLocalInputReport(analysis, provider.modelId);
  const sample = analysis.eligible.map((movie) => ({
    ...movie,
    rank: createHash("sha256").update(movie.id).digest("hex"),
  })).sort((left, right) => compareText(left.rank, right.rank) || compareText(left.id, right.id)).slice(0, limit);
  if (sample.length < limit) throw new Error("There are fewer eligible full-plot movies than requested.");
  const results = [];
  for (const movie of sample) {
    const start = performance.now();
    const result = await provider.embedText(movie.text);
    const elapsedMs = Math.round(performance.now() - start);
    validateEmbeddingVectors([result.embedding], 1, LOCAL_DIMENSIONS);
    results.push({ id: movie.id, dimensions: result.embedding.length, elapsedMs });
  }
  console.log(JSON.stringify(results, null, 2));
}

try {
  await main();
} catch (error) {
  console.error("Local embedding test failed: " + error.message);
  process.exitCode = 1;
}
