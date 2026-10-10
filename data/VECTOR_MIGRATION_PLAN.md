# V2 collection migration preparation (Milestone 6D.3A)

**Status: read-only planning.** `movies_local_384_v2` is not created in this milestone. `movies_local_384` and its ten documents remain the source of truth. No embedding inference, Astra write, or OpenAI request is part of this command. Full-dataset ingestion remains disabled.

## Dry-run and approval gate

Run `npm.cmd run db:migrate-v2:dry-run` to inspect the current dataset, validated local cache entries, and Astra documents. The script accepts no options or `--dry-run`. Passing `--apply` fails before credentials or database access, including when combined with `--dry-run`. The planner has no create, update, insert, replace, drop, or delete call. It requires read/list access to both collections and the ten legacy documents; if v2 is absent, only legacy access is needed. Authentication, permission, and collection-definition failures stop the run without printing credentials.

The planner validates all 1,100 dataset IDs and source identities, then requires exactly ten legacy records. It reads and verifies each stable `_id`, complete plot, source URL, genre/year/title, source content hash, pinned local provider and model revision, chunk/aggregation version, and 384-dimensional unit vector. SDK `DataAPIVector` values are converted with `asArray()` before comparison. For each movie, the local cache must be a checksum-valid hit for the current source and chunk plan. Reusing that cached vector needs no re-embedding. The output lists only IDs, source hashes, destination statuses, and a legacy snapshot fingerprint; it does not print plots, vectors, or secrets.

If a compatible v2 collection already exists, the planner reads each destination `_id`. An exact metadata/vector match is `already-matching` and should be skipped by a future migration. A missing document is `copy-after-approval`; any mismatch or invalid vector is a `conflict` requiring investigation. Partial results are explicit. Every future write must receive an exact readback before it is marked complete, including a retry after an uncertain response. A checkpoint alone must never authorize a skip.

The October 10, 2026 read-only dry-run verified all ten legacy documents against the current dataset and validated local caches. It found v2 absent, ten `copy-after-approval` records, zero already-matching records, and zero conflicts. The result reports `liveExecutionAvailable: false`; no v2 live check is marked passed.

## Future collection creation and ten-record migration

This is a procedure for a separately approved implementation, **not an executable step in M6D.3A**:

1. Re-run the M6D.2 [schema audit](VECTOR_SCHEMA_V2.md) and this dry-run. Confirm the Astra account's capacity and database state. Capture the ten-record legacy snapshot and check collection listings again.
2. With explicit collection-management approval, create `movies_local_384_v2` only if absent, using `V2_COLLECTION_DEFINITION` from `lib/vector-schema.mjs`: 384 dimensions, cosine metric, client-supplied vectors, and an allowlist containing `$vector`, `content_type`, `genre`, `year`, `title`, and `embedding_provider`. Validate the returned descriptor. Reject an incompatible existing collection; never change, drop, or recreate it automatically.
3. With separate document-write approval, copy at most the ten verified existing movies under their original IDs. Before each write, recheck the dataset source hash, local cache checksum/provenance, current legacy record, and destination ID. Reuse validated cached vectors. Write one document, read it back with `$vector` projected, compare complete plot and all metadata and vector values, then advance. If the response is uncertain, read back before retrying. Stop on conflict and preserve per-record progress.
4. After a controlled sample, verify the v2 descriptor, exact `_id` lookup, full plot/source URL/hash/provenance readback, filters on `genre`, `year`, and `content_type`, `$vector` nearest-neighbor similarity with and without a metadata filter, and unchanged legacy count/IDs/metadata/vectors. These checks are **pending** because v2 does not yet exist. Metadata indexing and vector indexing must each be checked; one does not prove the other.
5. Only after the verification gate, plan a separate search cutover using the allowed collection selector. No search API or full-ingestion path is changed by this milestone.

## Rollback and account effects

Keep `movies_local_384` and its ten records unchanged throughout. If a later v2 cutover fails, point future search back to the legacy collection and reconcile the v2 checkpoint and remote documents. Never automatically delete either collection. Legacy rollback restores only the ten-record sample, **not** full-dataset coverage.

The current dry-run makes read-only Data API requests and local tokenizer/cache reads. A future v2 creation would consume another collection and its indexes; a ten-record copy would add document storage and write/read requests. DataStax's [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html) and [collection indexing guidance](https://docs.datastax.com/en/astra-db-serverless/api-reference/collection-indexes.html) describe general limits, not this account's remaining credits or collection capacity. Check the Astra console before approval. Use a read-capable token now; any future create/write token and authorization must be separately scoped and handled outside committed files.

## Explicit approval checklist for a future milestone

- [ ] Approve creation of `movies_local_384_v2` with the exact reviewed definition and confirm collection capacity.
- [ ] Approve at most ten v2 document writes, with per-record readback and stop-on-conflict behavior.
- [ ] Reverify the legacy snapshot, dataset fingerprint, cache checksums, model revision, and zero unexpected destination records immediately before execution.
- [ ] Confirm account quotas, monitoring, recovery operator, and access permissions in the Astra console.
- [ ] Complete [plot attribution and page-specific licensing review](ATTRIBUTION.md) before wider distribution.
- [ ] Review live v2 `_id`, metadata-filter, and vector-query results before any search cutover.

This checklist records future prerequisites; it is not an approval request or an execution flag. Full ingestion needs its own separately approved design and remains disabled.
