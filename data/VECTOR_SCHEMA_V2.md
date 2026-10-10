# Versioned local vector storage proposal (Milestone 6D.2)

**Current status:** This document records the M6D.2 design and offline audit. A later controlled operation created `movies_local_384_v2` on October 10, 2026; three of the ten approved legacy records are present after an interrupted migration. The hardcoded write gate is closed. See [VECTOR_MIGRATION_PLAN.md](VECTOR_MIGRATION_PLAN.md) for live evidence and recovery status. `movies_local_384` remains unchanged and full ingestion is disabled.

## Collection definition

`movies_local_384_v2` is a separate namespace for client-supplied, pinned local MiniLM vectors. The installed `@datastax/astra-db-ts` SDK accepts `vector` and `indexing.allow` in `Db.createCollection` options. The controlled creation used the definition exported from `lib/vector-schema.mjs`:

```js
{
  vector: { dimension: 384, metric: "cosine" },
  indexing: {
    allow: ["$vector", "content_type", "genre", "year", "title", "embedding_provider"]
  }
}
```

There is no `vector.service`, so Astra-managed embedding generation is not enabled. The collection has no OpenAI documents or vectors. The SDK's collection definition supports `indexing.allow`, and Astra's [collection indexing documentation](https://docs.datastax.com/en/astra-db-serverless/api-reference/collection-indexes.html) says selective indexing is fixed when the collection is created. `$vector` is explicitly allowed for vector similarity; it is a vector index, not an 8,000-byte metadata string. [Vector search documentation](https://docs.datastax.com/en/astra-db-serverless/databases/vector-search.html) requires a vector-enabled collection with vector data and a `$vector` sort. Stable `_id` equality readback uses the document ID. Only the five allowlisted metadata fields may be used for metadata filters; `plot`, `source_url`, `content_hash`, `embedding_model`, `model_revision`, `embedding_version`, and `chunk_count` remain stored but non-indexed. Title is filterable, not a full-text search feature. No additional future filter fields are enabled by assumption.

The Astra collection descriptor can report default lexical and rerank settings even though creation specified only a vector. The v2 validator accepts only those known server defaults if returned; it rejects changed lexical or rerank settings. This design never calls lexical search, reranking, or Astra vectorization. The live v2 descriptor passed this validator after creation.

`validateV2CollectionDescriptor` rejects a legacy name, wrong dimension or metric, vectorization service, unexpected source model, changed or missing allowlist, and unexpected collection settings. `inspectV2Collection` only calls `listCollections` and returns a collection handle after validation. It has no create, update, or drop method. The `MOVIE_VECTOR_COLLECTION` resolver permits only the existing local name or v2, defaults to the legacy name to preserve current behavior, and rejects OpenAI or unknown namespaces. Existing production code still targets the legacy collection; a future approved ingestion/search implementation must explicitly select v2 and validate its descriptor before use.

## Document shape and size policy

Movie IDs remain the existing stable `movie_<hex>` values. Future series IDs should use a separate `series_<hex>` namespace and `content_type: "series"` with a separately validated source contract; no series ingest path is implemented here. Movie documents retain `_id`, `content_type`, `title`, numeric or null `year`, `genre` (including the one genuine empty value), the **complete original** `plot`, original `source_url`, `content_hash`, `embedding_provider`, `embedding_model`, `model_revision`, `embedding_version`, `chunk_count`, and a client-supplied `$vector`. The existing movie builder checks the current source hash, pinned provider/model/revision, chunking and aggregation version, cache integrity hash, 384 finite values, and unit norm. The v2 wrapper then checks exact source fields and UTF-8 storage size. No plot is truncated or summarized. Source links and attribution remain available even though they are not indexed.

DataStax's [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html) state **8,000 UTF-8 bytes per indexed string** and **4 million characters per document**. The local validator measures the serialized document in UTF-8 bytes and rejects it above **4,000,000 bytes**; it also checks the documented character ceiling. The byte ceiling is deliberately stricter than the published character limit, not a claim that Astra publishes a 4 MB document-byte limit. It checks indexed string fields separately. For records without embeddings, the offline audit includes complete source metadata and reserves 33 serialized bytes for each of 384 vector components; this conservative allowance avoids generating embeddings. The actual document must be revalidated with its real vector before any future write.

Run `npm.cmd run db:schema-v2` to reproduce the offline dataset check. On the October 10, 2026 dataset of 1,100 validated movies, it found:

| Measure | Result |
| --- | ---: |
| Records assessed / representable under the conservative v2 bound | 1,100 / 1,100 |
| v2 size or indexed-string violations | 0 |
| Plots over the **legacy indexed** 8,000-byte limit | 8 |
| Largest complete plot | 29,395 UTF-8 bytes |
| Largest projected complete v2 document, including vector allowance | 42,560 UTF-8 bytes |
| Genuine empty genres preserved | 1 |

This is a local representability check, not proof of server acceptance for all 1,100 records. The eight long plots become stored non-indexed fields; all other allowlisted string values passed the 8,000-byte check. The later controlled run live-verified three small records, exact `_id` readback, metadata filters, and vector similarity. Seven approved records and all 1,090 other movies remain outside v2.

## Migration status, remaining verification, and rollback

1. The controlled operation created v2 once with the exact definition above. The live descriptor passed validation. Account-specific remaining credits and usable capacity remain unknown; check the Astra Portal before resuming. Never alter or drop the legacy collection.
2. Three verified legacy documents now exist in v2 under the same IDs. Complete the seven missing IDs only after a renewed approval and fresh checks against dataset content, cached embedding checksums, provenance, the pinned legacy snapshot, and v2 size limits. Reuse validated cached vectors rather than re-embedding. Read back the full plot, source URL, hash, provider, revision, vector, and dimensions after each future write.
3. In a separately approved execution milestone, generate only missing local embeddings with an explicit gate. Preserve the ten-record batch cap until a new run policy is approved. Keep a v2-specific checkpoint with dataset and schema fingerprints; reconcile uncertain writes remotely and never skip solely from checkpoint state. Preserve bounded retries and per-document readback.
4. Exact `_id` readback, `genre`/`year`/`content_type` filters, and `$vector` similarity (including a metadata-filtered query) passed on the three present records. Full ten-record verification and untested metadata fields remain pending. Audit all 1,100 full documents before any separately approved ingestion or search cutover. Do not mix local 384-dimensional vectors with the separate OpenAI 1,536-dimensional namespace.
5. Roll back a future search cutover by selecting `movies_local_384` again. Keep v2 and its checkpoint for investigation and reconciliation. Do not delete either collection automatically. Legacy remains a ten-record sample, so rollback does **not** provide full-dataset coverage.

Before broader distribution, review [dataset attribution and imported-text notices](ATTRIBUTION.md), including page-specific licensing conditions. Account-specific credits, collection capacity, and request quotas also require a manual Astra-console check. The schema design alone does not authorize full ingestion.
