import { readUnifiedMovies } from "../lib/movie-ingestion-sample.mjs";
import { assessV2MovieDataset } from "../lib/vector-schema.mjs";

if (process.argv.length !== 2) throw new Error("The v2 audit accepts no options.");
const result = assessV2MovieDataset(await readUnifiedMovies());
console.log(JSON.stringify({ mode: "offline-v2-storage-audit", databaseReads: 0,
  databaseWrites: 0, inferenceCalls: 0, ...result }, null, 2));
if (result.violations.length) process.exitCode = 1;
