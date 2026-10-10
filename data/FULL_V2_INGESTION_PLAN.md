# Full movie ingestion preparation

**Status (October 11, 2026): implementation complete for review; live execution disabled.** The separate hardcoded full-ingestion gate in `lib/full-v2-ingestion.mjs` is **closed**. This work performed no document write, collection change, embedding inference, OpenAI request, or search cutover. The earlier ten-record migration gate remains closed and is not used by this command.

## Scope and command

`npm.cmd run db:ingest-full-v2` is the default **read-only dry-run**. It validates `data/all-movies.csv`, local cache provenance, the existing `movies_local_384_v2` descriptor, the ten legacy sample records, the complete v2 ID/hash inventory, all present document contents and vectors, and a separate checkpoint if one exists. It performs no embedding inference and writes neither the database nor the checkpoint. `--apply --confirm-full-ingestion` is the future write syntax, but the hardcoded gate rejects it before source files, credentials, or Astra access until a separately reviewed code change opens that gate. No environment variable or CLI flag opens it.

The future apply path targets only `movies_local_384_v2`. It rejects a missing or incompatible collection and never creates, alters, drops, or recreates a collection. It validates the pinned `Xenova/all-MiniLM-L6-v2` revision, 384-dimensional cosine schema, explicit indexing allowlist, original source IDs and plots, URLs, year and genre, content hashes, cache checksums, chunk and aggregation versions, and finite unit vectors. The legacy `movies_local_384` collection is only read and its pinned ten-record snapshot must remain unchanged. The application continues to select the legacy collection by default.

## Measured read-only dry-run

The October 11 dry-run against the current local source and live Astra collections reported:

| Check | Result |
| --- | ---: |
| Source records / unique IDs | 1,100 / 1,100 |
| Exact matching v2 documents | 10 |
| Missing v2 documents / conflicts | 1,090 / 0 |
| Reusable caches among missing records | 0 |
| Invalid caches among missing records | 0 |
| Local inference required | 1,090 movies / 3,113 chunks |
| v2 size or indexed-field violations | 0 |
| Largest projected document, including vector allowance | 42,560 UTF-8 bytes |
| Conservative sum of projected JSON bytes for missing documents | 16,716,263 bytes |
| Database writes / inference calls / checkpoint writes | 0 / 0 / 0 |

The projected byte sum reserves 33 serialized bytes per vector component and preserves complete plots, including the eight plots above the **legacy** 8,000-byte indexed-string limit. The v2 schema stores plots unindexed. This is a local serialized-document allowance, **not** a measurement of Astra logical storage, index overhead, replication, billable credits, or guaranteed server acceptance of all future writes. Each complete document is validated again with its real vector before any future insertion. The empty-genre record keeps its original empty value.

The dataset fingerprint is `978a967571378f711aa8f5aa47bc7a1fe8dd21b2dcb68fd6e4a2be22c9bc290c`. The full-v2 configuration fingerprint is `9a9097a3bc02e3f07342ecc3aa3c9d57dd719b46b92c38053583ff5933379f2a`. These values change when source content or the reviewed schema/model/chunking/write policy changes.

## Future execution and recovery behavior

The full-v2 checkpoint is separate from the ten-record sample checkpoint and lives in ignored `data/cache/ingestion/full-v2-movies.json`. It stores only IDs, source hashes, statuses, dataset hash, configuration hash, and deterministic order; it contains no vectors, plots, or credentials. Writes use the existing atomic temporary-file-and-rename helper. A corrupt or incompatible checkpoint stops the run. A checkpoint entry never permits a skip by itself: every run first reads the whole destination inventory, rejects unknown IDs and hash conflicts, and verifies every present document against checksum-valid cache data and source metadata. A checkpoint claiming a verified record that is absent remotely stops for investigation.

After a future approval, the executor would process missing IDs sequentially. It reuses verified cached vectors where available and otherwise calls the pinned local model with the existing chunking and aggregation code, then writes the validated cache before constructing the v2 document. The ten exact existing documents are skipped. Each missing ID receives an exact-ID precheck and at most **one** create-only `insertOne` attempt; existing conflicts stop the run. An uncertain insert receives at most three bounded, read-only exact-ID reconciliation probes. It is never blindly retried. A successful write also receives bounded exact readback. Checkpoint progress is saved after each verified record; quota, permission, connection, and integrity failures stop without deleting successful documents. A later approved run must reconcile remote state anew. A final read-only pass requires all 1,100 IDs and hashes, complete documents, and an unchanged legacy snapshot.

## Capacity, access, and source rights

The current v2 collection is reachable and matches the reviewed 384-dimensional cosine, client-vector, selective-index definition. The current Astra token's role allows database reads and document modification but lacks `org-billing-read`; the actual remaining credit balance, storage/index headroom, and account-specific request allowance are **UNKNOWN**. The closed code gate prevents this token from starting this command's write path. Before any future gate change or live run, an authorized billing operator must inspect **Astra Portal → Settings → select the organization → Billing** for current credits and usage, plus the database Data Explorer for collection/index state. General [Astra database limits](https://docs.datastax.com/en/astra-db-serverless/databases/database-limits.html), [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html), and [credit and usage guidance](https://docs.datastax.com/en/astra-db-serverless/administration/subscription-usage.html) do not establish this account's remaining capacity. Plan monitoring and a single operator before a full run.

The source URLs and complete plots remain stored for attribution. Review [ATTRIBUTION.md](ATTRIBUTION.md) and article-level imported-text or redistribution conditions before broad publication; this preparation is not an exhaustive rights audit. Full ingestion and any search-collection cutover need separate operational approval. The ten-record legacy collection remains available as a rollback source with ten-record coverage only.
