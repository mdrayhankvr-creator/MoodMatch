# Controlled v2 sample migration execution

**Date:** October 11, 2026
**Scope:** Complete the ten-record legacy sample in `movies_local_384_v2`; no full-dataset ingestion or search cutover.

## Authorized scope and preflight

The branch retained checkpoint commit `ac5dbe8ee517e3673cc0ebce10207136b5a8b1f7` and the subsequent reliability fix. Before the resume, `movies_local_384` held exactly ten approved records. The v2 collection had exactly three matching records and seven missing records, with no unexpected IDs or conflicts. The pinned legacy snapshot was `2126ad176c046aa4c1e728a00ef982fafdd8efe4c38e2d64b11a8c810723bae4`. The destination descriptor matched the reviewed client-vector schema: 384 dimensions, cosine metric, and selective indexing of `$vector`, `content_type`, `genre`, `year`, `title`, and `embedding_provider`; plots and source URLs are stored without metadata indexing.

The read-only preflight reconciled all ten exact IDs against the source dataset, checksum-valid cached embeddings, metadata, content hashes, model provenance, and full vectors. An independent destination inventory and exact-ID readback confirmed the same three matching documents and the seven absences. The token's read and document-modify permissions were confirmed from read-only role inspection without disclosing credentials. Account-specific remaining credits and index headroom were **UNKNOWN**: the token did not have billing-read access. One transient connection timeout occurred during an initial read-only preflight; the repeated preflight passed. The earlier interrupted migration's underlying API/readback error remains **unknown** because its original SDK exception was not retained.

## Controlled apply

The hardcoded gate was opened only for one invocation of `node scripts/migrate-vector-v2.mjs --apply --confirm-v2-migration` and restored to **CLOSED** in a `finally` step immediately afterward. The code additionally restricted possible writes to the seven pinned resume IDs. The three matching documents were skipped; the following seven were inserted and read back successfully:

| Approved inserted ID |
| --- |
| `movie_291791a7023c7142a461` |
| `movie_4059449640323dea46a1` |
| `movie_75815234577520e0e9a0` |
| `movie_85756b984da7bede7e0f` |
| `movie_8f86ea94b9f4f2c7388c` |
| `movie_a27a1114f9e4cd9adb12` |
| `movie_e438309a72dfda243a5b` |

The apply returned successfully: **3 already matching, 7 inserted, 0 conflicts**. No uncertain insert or readback failure occurred during this invocation. Each `insertOne` was create-only, with no overwrite or automatic retry of an uncertain write. No embedding inference, OpenAI request, collection creation/deletion, legacy write, or search collection switch occurred.

## Independent read-only verification

After closing the gate, a separate dry-run found **10 already matching, 0 missing, 0 conflicts** and performed zero writes or inference. A separate read-only inventory scanned the destination and found exactly the ten expected IDs and hashes, with no unexpected records. Exact-ID reads verified complete original plots, source URLs, metadata, content hashes, model provenance, and vector values for all ten; the seven resumed IDs were present. The live verifier confirmed the descriptor, 384-dimensional client vectors, `content_type`/`genre`/`year` metadata filters, and vector nearest-neighbor retrieval with and without a metadata filter. Both similarity checks returned finite scores of **1** for the expected record. The ten-record legacy count, IDs, contents, and pinned snapshot were unchanged. These live checks apply to this ten-record sample, not to the other 1,090 movies.

## Safety state and remaining work

The hardcoded apply gate is **CLOSED**. Both apply flags are still required, and a new write attempt is rejected before database access while the gate is closed. The normal collection selector still defaults to the legacy collection. The ten v2 sample records remain available for read-only verification; rollback from any future search cutover is to select `movies_local_384` explicitly, with only ten-record sample coverage. Full-dataset ingestion remains disabled.

Final local validation passed: `npm.cmd run lint`, `npx.cmd tsc --noEmit`, and `npm.cmd run test` (90/90 offline tests). `npm.cmd run db:migrate-v2:dry-run` reported ten matching records, zero missing, zero conflicts, zero database writes, and zero inference calls. A closed-gate `--apply --confirm-v2-migration` invocation refused before database access.

Before broader use, check account credits, quotas, and index headroom in the Astra Portal with an authorized billing operator. Review token rotation against a trusted credential record. Complete the source attribution and page-specific licensing review in [ATTRIBUTION.md](ATTRIBUTION.md) before wider distribution; the sample migration is not an exhaustive article-level rights audit. The other 1,090 movies have not been ingested or live-verified. Any future full ingestion or search cutover requires a separate design and approval.
