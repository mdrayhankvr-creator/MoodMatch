# Full movie ingestion preparation

**Status (October 11, 2026): all 1,100 v2 movies ingested and independently verified.** The separate hardcoded full-ingestion gate in `lib/full-v2-ingestion.mjs` is **closed again**. No collection definition, legacy record, or search selector was changed. The earlier ten-record migration gate remains closed. No OpenAI request was made.

## Scope and command

`npm.cmd run db:ingest-full-v2` is the default **read-only dry-run**. It validates `data/all-movies.csv`, local cache provenance, the existing `movies_local_384_v2` descriptor, the ten legacy sample records, the complete v2 ID/hash inventory, all present document contents and vectors, and the separate checkpoint. It performs no embedding inference and writes neither the database nor the checkpoint. `--apply --confirm-full-ingestion` is the write syntax, but the hardcoded gate is closed after the controlled run and rejects it before source files, credentials, or Astra access. No environment variable or CLI flag opens it.

The apply path targets only `movies_local_384_v2`. It rejects a missing or incompatible collection and never creates, alters, drops, or recreates a collection. It validates the pinned `Xenova/all-MiniLM-L6-v2` revision, 384-dimensional cosine schema, explicit indexing allowlist, original source IDs and plots, URLs, year and genre, content hashes, cache checksums, chunk and aggregation versions, and finite unit vectors. The legacy `movies_local_384` collection is only read and its pinned ten-record snapshot must remain unchanged. The application continues to select the legacy collection by default.

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

## Completed local preparation and controlled execution

Local-only preparation generated 1,090 embeddings from 3,113 chunks and rechecked all 1,090 cache entries. The pre-execution read-only run found 10 matching v2 documents, 1,090 missing, no conflicts, 1,090 reusable caches, and no further inference requirement. Official [Free-plan guidance](https://docs.datastax.com/en/astra-db-serverless/administration/subscription-plans.html) and [credits guidance](https://docs.datastax.com/en/astra-db-serverless/administration/subscription-usage.html) say Free organizations receive fixed monthly credits and their databases suspend at exhaustion until a monthly refresh or explicit paid-plan upgrade. The user confirmed this organization is Free-only, has no payment method or paid subscription, and authorized this run under a $0 paid-charge limit. The accessible DevOps API showed an Active database but did not expose plan or remaining credit fields; current account-specific balance remains unknown. No upgrade, purchase, or paid service was invoked.

The scoped run performed **1,090 insert-only writes** to v2, with exact-ID readback after each, **zero** uncertain-write reconciliations, and **zero** reported insert failures, quota events, or suspensions. The first bounded batch also passed an inventory count check. The ignored checkpoint contains 10 matching and 1,090 inserted source-bound outcomes. After all inserts, the command's first final read-only audit stopped on a sanitized `countDocuments` error with no available HTTP status or API code; the exact underlying cause is unknown. It did **not** indicate an insert failure. The write gate was restored closed, and no insert was repeated.

A subsequent closed-gate dry-run independently reconciled **1,100 matching / 0 missing / 0 conflicts**, with zero database, inference, or checkpoint writes. A separate paginated full-document scan verified all 1,100 IDs, complete plots, source URLs, hashes, metadata, model provenance, and vectors. Indexed `content_type`, `genre`, and `year` filters returned exactly the expected IDs. Both unfiltered and content-type-filtered vector searches returned the query movie in the top ten with similarity `1`. The legacy ten-record snapshot was unchanged, and the default search selector remains `movies_local_384`. An earlier independent-verifier attempt also stopped without a classified cause; its read-only rerun passed. These read failures remain unexplained and did not trigger database writes.

The full-set inventory and independent scan use paginated `find` because the [Astra TypeScript SDK count API](https://docs.datastax.com/en/astra-api-docs/_attachments/typescript-client/classes/Collection.html) has a 1,000-document exact-count ceiling. Exact-ID counts used during per-document readback remain bounded to one matching ID.

## Execution and recovery behavior

The full-v2 checkpoint is separate from the ten-record sample checkpoint and lives in ignored `data/cache/ingestion/full-v2-movies.json`. It stores only IDs, source hashes, statuses, dataset hash, configuration hash, and deterministic order; it contains no vectors, plots, or credentials. Writes use the existing atomic temporary-file-and-rename helper. A corrupt or incompatible checkpoint stops the run. A checkpoint entry never permits a skip by itself: every run first reads the whole destination inventory, rejects unknown IDs and hash conflicts, and verifies every present document against checksum-valid cache data and source metadata. A checkpoint claiming a verified record that is absent remotely stops for investigation.

The executor processes missing IDs sequentially. It reuses verified cached vectors where available and otherwise calls the pinned local model with the existing chunking and aggregation code, then writes the validated cache before constructing the v2 document. The ten exact existing documents were skipped. Each missing ID receives an exact-ID precheck and at most **one** create-only `insertOne` attempt; existing conflicts stop the run. An uncertain insert receives at most three bounded, read-only exact-ID reconciliation probes. It is never blindly retried. A successful write also receives bounded exact readback. Checkpoint progress is saved after each verified record; quota, permission, connection, and integrity failures stop without deleting successful documents. Any later approved run must reconcile remote state anew. A final read-only pass requires all 1,100 IDs and hashes, complete documents, and an unchanged legacy snapshot.

## Capacity, access, and source rights

The current v2 collection is reachable and matches the reviewed 384-dimensional cosine, client-vector, selective-index definition. The current Astra token's role allows database reads and document modification but lacks `org-billing-read`; the actual remaining credit balance, storage/index headroom, and account-specific request allowance are **UNKNOWN**. The closed code gate prevents another write run. An authorized billing operator can inspect **Astra Portal → Settings → select the organization → Billing** for current credits and usage. General [Astra database limits](https://docs.datastax.com/en/astra-db-serverless/databases/database-limits.html), [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html), and [credit and usage guidance](https://docs.datastax.com/en/astra-db-serverless/administration/subscription-usage.html) do not establish this account's remaining balance or prove that every account-specific charge display is zero.

The source URLs and complete plots remain stored for attribution. Review [ATTRIBUTION.md](ATTRIBUTION.md) and article-level imported-text or redistribution conditions before broad publication; this work is not an exhaustive rights audit. No public full-plot endpoint was added. Any search-collection cutover needs separate review. The ten-record legacy collection remains available as a rollback source with ten-record coverage only.
