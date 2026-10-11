import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import csv from "csv-parser";
import { MOVIE_COLUMNS, strictUtf8 } from "../scripts/movie-data.mjs";
import { validateFullDataset } from "./full-ingestion-readiness.mjs";
import { makeCatalogue } from "./catalogue.mjs";
import { cacheLife } from "next/cache";

let snapshotPromise;

async function readCatalogueSource() {
  // The fixed data subdirectory prevents Turbopack from tracing the whole workspace.
  const bytes = await readFile(join(process.cwd(), "data", "all-movies.csv"));
  const rows = [];
  const parser = csv({ strict: true });
  parser.once("headers", (headers) => {
    if (headers.length !== MOVIE_COLUMNS.length || headers.some((name, index) => name !== MOVIE_COLUMNS[index])) {
      parser.destroy(new Error("Catalogue source schema is invalid."));
    }
  });
  await pipeline(Readable.from([bytes]), strictUtf8(), parser, async (records) => {
    for await (const row of records) rows.push(row);
  });
  return rows;
}

/** Validated, read-only source snapshot; the browser never receives plot text. */
export async function getCatalogueSnapshot() {
  "use cache";
  cacheLife("days");
  if (!snapshotPromise) {
    snapshotPromise = readCatalogueSource().then((rows) => {
      validateFullDataset(rows, 1100);
      return makeCatalogue(rows);
    }).catch((error) => { snapshotPromise = undefined; throw error; });
  }
  return snapshotPromise;
}
