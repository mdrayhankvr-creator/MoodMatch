# Full dataset ingestion readiness (Milestone 6C)

Read-only preflights on October 9, 2026 used `data/all-movies.csv`, the pinned local model, validated cache entries, and the existing `movies_local_384` collection. This is a planning snapshot. No full-dataset inference or Astra write was run.

| Measure | Result |
| --- | ---: |
| Dataset records, unique IDs, unique Wikipedia source identities | 1,100 each |
| Dataset byte fingerprint (SHA-256) | `978a967571378f711aa8f5aa47bc7a1fe8dd21b2dcb68fd6e4a2be22c9bc290c` |
| Validated reusable local embeddings | 10 |
| Missing local embeddings | 1,090 |
| Stale or invalid current cache entries | 0 |
| Planned total chunks | 3,140 |
| Chunks requiring future local inference | 3,113 |
| Existing remote dataset records, read-only verified | 10 |
| Candidate new remote documents after approval | 1,090 |
| Planned batches at size 10 | 110 |

The collection descriptor reports 384 dimensions and cosine similarity. All ten existing documents matched current source hashes, local provider, pinned `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9`, chunk/aggregation version, metadata, and cached vectors. Offline model loading succeeded with remote model downloads disabled. One dataset record has an empty genre (`movie_dd0f87ec3b09193d2c11`); the current movie schema allows this, but it should be reviewed before broader use. No release year is missing.

## Run the preflight

```powershell
npm.cmd run db:preflight
npm.cmd run db:preflight:remote
```

The first command reads only the dataset, local model files, and local embedding cache. It tokenizes every record to calculate chunk counts; it does not infer embeddings, contact Astra, or write files. The second command adds read-only Astra inventory and readback verification. It requires valid local Astra credentials. Both commands refuse execution flags. The preflight reports current system memory and process RSS as observations, not as a prediction of full inference memory.

## Execution design and stop behavior

Full-dataset execution is **disabled** in this milestone. The existing M6B commands still cap an apply run at ten records. The separate full planner permits batches of 1–10 and planned concurrency of 1–2; its default is sequential batches of ten. It exposes no write command or collection-management operation. The 1,100-record rehearsal is in-memory and uses mock outcomes only.

For a later approved implementation, retain a separate, explicit execution gate and require the local 384-dimensional provider, pinned model revision, current content hash, chunk configuration, cache checksum, and unit-norm vector before every write. Infer a missing embedding only under a separate explicit authorization. Never send local vectors to the OpenAI namespace, recreate a collection automatically, or use a checkpoint to bypass remote verification. Preserve bounded retries, a read after an uncertain write, per-record results, and readback after every apparent success. Stop scheduling new work when an operator interrupts the process; let in-flight operations finish or mark them uncertain, then reconcile them remotely before retrying. Do not skip a record merely because a checkpoint says it succeeded.

The proposed full checkpoint has its own version, dataset fingerprint, configuration fingerprint, ordered IDs, per-record states (`planned`, `verified`, `write-uncertain`, `failed`), progress counters, completed batch indexes, and recoverable failure list. The current M6B checkpoint remains at `data/cache/ingestion/local-movies-384.json` and is read without modification. It was compatible in this snapshot, but covers only the ten-record sample. A future full checkpoint must use a separate path and must reject fingerprint or version changes. Verified and uncertain entries both require remote reconciliation on restart. No full checkpoint is persisted by 6C.

## Remaining requirements and limits

- Obtain explicit approval for full local inference and the additional database writes. Re-run both preflights immediately before execution; the 1,090 candidate writes can change with the database or dataset.
- Benchmark actual inference throughput and peak memory on this host. The 3,113 missing chunks are a tokenizer-derived workload count, not a runtime or memory forecast. Ensure sufficient free disk for model/cache artifacts and a restart-safe cache location.
- Confirm account plan, remaining capacity, request budget, collection/index settings, and rate limits in the Astra portal. [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html) include a 20-document page size for some reads and a four-million-character document limit. [Astra DB Serverless limits](https://docs.datastax.com/en/astra-db-serverless/databases/database-limits.html) note free-plan database limits, hibernation of inactive databases, and no metrics export. Use application progress logs and readback counters if metrics export is unavailable. Verify current limits before scheduling work.
- Review the [dataset attribution and imported-text caveats](ATTRIBUTION.md), including page-specific notices, before wider distribution of all Wikipedia plots. Preserve source links and required attribution in downstream displays.
- Add a separately approved execution implementation with operational monitoring, interruption handling, checkpoint persistence, and a controlled rollout. The mock rehearsal does not prove production write throughput or recovery under real Astra failures.
