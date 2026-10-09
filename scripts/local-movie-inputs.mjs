import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import { buildMovieEmbeddingInput } from "../lib/embedding-runtime.mjs";
import { LOCAL_MAX_TOKENS } from "../lib/embedding-provider.mjs";
import { MOVIE_COLUMNS, strictUtf8 } from "./movie-data.mjs";

const CSV_PATH = resolve("data/all-movies.csv");
const REPORT_PATH = resolve("data/LOCAL_INPUT_REPORT.md");

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function analyzeLocalMovieInputs(provider) {
  if (provider.id !== "local" || typeof provider.tokenCounts !== "function") {
    throw new Error("Local input analysis requires the local embedding provider.");
  }
  const movies = [];
  const parser = csv({ strict: true });
  let headerSeen = false;
  parser.once("headers", (headers) => {
    headerSeen = true;
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((column, index) => column !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error("Unified movie CSV schema is invalid."));
    }
  });
  await pipeline(createReadStream(CSV_PATH), strictUtf8(), parser, async (rows) => {
    for await (const row of rows) {
      if (!row.id || !row.title || !row.plot || !row.source_url) {
        throw new Error("Unified CSV has a missing required movie field.");
      }
      movies.push({ id: row.id, title: row.title, text: buildMovieEmbeddingInput(row) });
    }
  });
  if (!headerSeen || movies.length === 0) throw new Error("Unified movie CSV is empty.");
  const counts = await provider.tokenCounts(movies.map((movie) => movie.text));
  if (!Array.isArray(counts) || counts.length !== movies.length) throw new Error("Local tokenizer returned incomplete counts.");
  const analyzed = movies.map((movie, index) => ({
    ...movie,
    tokenCount: counts[index],
  }));
  if (analyzed.some((movie) => !Number.isInteger(movie.tokenCount) || movie.tokenCount < 1)) {
    throw new Error("Local tokenizer returned invalid token counts.");
  }
  const eligible = analyzed.filter((movie) => movie.tokenCount <= LOCAL_MAX_TOKENS);
  const requiresChunking = analyzed.filter((movie) => movie.tokenCount > LOCAL_MAX_TOKENS);
  return { eligible, requiresChunking, total: analyzed.length };
}

export async function writeLocalInputReport(analysis, modelId) {
  const csvBytes = await readFile(CSV_PATH);
  const fingerprint = createHash("sha256").update(csvBytes).digest("hex");
  const longRows = [...analysis.requiresChunking].sort((left, right) => compareText(left.id, right.id));
  const escape = (value) => value.replaceAll("|", "\\|");
  const content = [
    "# Local embedding input report",
    "",
    `Model: \`${modelId}\` (384 dimensions, CPU).`,
    `Source: \`data/all-movies.csv\` SHA-256 \`${fingerprint}\`.`,
    "",
    `The model card says inputs above ${LOCAL_MAX_TOKENS} wordpieces are normally truncated.`,
    "This pipeline counts tokenizer IDs including special tokens without truncation and",
    "rejects longer inputs before inference. These records require M5B chunking to represent",
    "their full plots; none was shortened or embedded in this report.",
    "",
    "| Measure | Count |",
    "| --- | ---: |",
    `| Total movies inspected | ${analysis.total} |`,
    `| Full-input eligible | ${analysis.eligible.length} |`,
    `| Require chunking | ${longRows.length} |`,
    "",
    "## Records requiring chunking",
    "",
    "| Movie ID | Title | Token count |",
    "| --- | --- | ---: |",
    ...longRows.map(({ id, title, tokenCount }) => `| \`${id}\` | ${escape(title)} | ${tokenCount} |`),
    "",
  ].join("\n");
  try {
    if (await readFile(REPORT_PATH, "utf8") === content) return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = REPORT_PATH + "." + process.pid + ".tmp";
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, REPORT_PATH);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
