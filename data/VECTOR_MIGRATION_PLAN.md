# V2 collection migration (Milestones 6D.3A and 6D.3B)

**Status: live implementation prepared, execution hard-disabled.** `movies_local_384_v2` has not been created. `movies_local_384` and its ten documents remain the source of truth. M6D.3B performs no embedding inference, Astra write, or OpenAI request. Full-dataset ingestion remains disabled.

## Dry-run and approval gate

Run `npm.cmd run db:migrate-v2:dry-run` to inspect the current dataset, validated local cache entries, and Astra documents. No option or `--dry-run` selects read-only planning. The CLI recognizes a future write request only when **both** `--apply` and `--confirm-v2-migration` are supplied; its hardcoded M6D.3B gate still refuses that request before credentials or database access. No environment value or flag can open the gate. The exported collection-creation and migration functions enforce the same gate before their first database read. The dry-run planner has no write call. It requires read/list access to both collections and the ten legacy documents; if v2 is absent, only legacy access is needed. Authentication, permission, and collection-definition failures stop the run without printing credentials.

The planner validates all 1,100 dataset IDs and source identities, then requires exactly ten legacy records. It reads and verifies each stable `_id`, complete plot, source URL, genre/year/title, source content hash, pinned local provider and model revision, chunk/aggregation version, and 384-dimensional unit vector. SDK `DataAPIVector` values are converted with `asArray()` before comparison. For each movie, the local cache must be a checksum-valid hit for the current source and chunk plan. Reusing that cached vector needs no re-embedding. The output lists only IDs, source hashes, destination statuses, and a legacy snapshot fingerprint; it does not print plots, vectors, or secrets.

If a compatible v2 collection already exists, the planner reads each destination `_id`. An exact metadata/vector match is `already-matching` and should be skipped by a future migration. A missing document is `copy-after-approval`; any mismatch or invalid vector is a `conflict` requiring investigation. Partial results are explicit. Every future write must receive an exact readback before it is marked complete, including a retry after an uncertain response. A checkpoint alone must never authorize a skip.

The October 10, 2026 read-only dry-run verified all ten legacy documents against the current dataset and validated local caches. It found v2 absent, ten `copy-after-approval` records, zero already-matching records, and zero conflicts. The result reports `liveExecutionAvailable: false`; no v2 live check is marked passed.

## Guarded collection creation and ten-record migration

The implementation in `lib/vector-v2-live-migration.mjs` is present for review and mocked tests. Its hardcoded gate is closed throughout M6D.3B. A later, separately reviewed code change and explicit operational approval are required before these steps can execute:

1. Re-run the M6D.2 [schema audit](VECTOR_SCHEMA_V2.md) and this dry-run. Confirm the Astra account's capacity and database state. Capture the ten-record legacy snapshot and check collection listings again.
2. With explicit collection-management approval, inspect the current descriptors and create `movies_local_384_v2` only if absent, using the installed SDK and `V2_COLLECTION_DEFINITION` from `lib/vector-schema.mjs`: 384 dimensions, cosine metric, client-supplied vectors, and an allowlist containing `$vector`, `content_type`, `genre`, `year`, `title`, and `embedding_provider`. Full plots and source URLs are stored unindexed. Re-list and validate the descriptor after creation, including a concurrent-creation race. Reject an incompatible existing collection; never change, drop, or recreate it automatically.
3. With separate document-write approval, copy at most the ten verified existing movies under their original IDs. Before each write, re-plan from the current legacy records and checksum-valid local cache; require the original legacy snapshot and a conflict-free destination inventory. Reuse validated cached vectors and use create-only `insertOne` so an existing ID cannot be overwritten. Read back `$vector`, full plot, source URL, hashes, and provenance after every write. If the response is uncertain, read back before retrying; a later run skips exact matches. Stop on mismatch or conflict, preserve successful documents, and reconcile the partial destination on the next dry-run.
4. After a controlled sample, run the reusable read-only verifiers for the v2 descriptor, exact `_id` lookup, full plot/source URL/hash/provenance readback, ten IDs and hashes, filters on `genre`, `year`, and `content_type`, `$vector` nearest-neighbor similarity with and without a metadata filter, and unchanged legacy count/IDs/metadata/vectors. These checks have only passed with mocks; real v2 results are **pending** because the collection does not yet exist. Metadata indexing and vector indexing must each be checked; one does not prove the other.
5. Only after the verification gate, plan a separate search cutover using the allowed collection selector. No search API or full-ingestion path is changed by this milestone.

## Rollback and account effects

Keep `movies_local_384` and its ten records unchanged throughout. Collection selection remains explicit through `MOVIE_VECTOR_COLLECTION`; no migration step switches it. If a later v2 cutover fails, select `movies_local_384` again for search and reconcile v2 documents through read-only inspection before any further operation. Never automatically delete either collection or its documents. Legacy rollback restores only the ten-record sample, **not** full-dataset coverage.

The current dry-run makes read-only Data API requests and local tokenizer/cache reads. A future v2 creation would consume another collection and its indexes; a ten-record copy would add document storage and write/read requests. DataStax's [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html) and [collection indexing guidance](https://docs.datastax.com/en/astra-db-serverless/api-reference/collection-indexes.html) describe general limits, not this account's remaining credits or collection capacity. Check the Astra console before approval. Use a read-capable token now; any future create/write token and authorization must be separately scoped and handled outside committed files. Do not log credentials, full vectors, or complete plots.

## Explicit approval checklist for a future milestone

- [ ] Approve creation of `movies_local_384_v2` with the exact reviewed definition and confirm collection capacity.
- [ ] Approve at most ten v2 document writes, with per-record readback and stop-on-conflict behavior.
- [ ] Reverify the legacy snapshot, dataset fingerprint, cache checksums, model revision, and zero unexpected destination records immediately before execution.
- [ ] Confirm account quotas, monitoring, recovery operator, and access permissions in the Astra console.
- [ ] Complete [plot attribution and page-specific licensing review](ATTRIBUTION.md) before wider distribution.
- [ ] Review live v2 `_id`, metadata-filter, and vector-query results before any search cutover.

This checklist records future prerequisites; it is not an approval request or an execution flag. Full ingestion needs its own separately approved design and remains disabled.
