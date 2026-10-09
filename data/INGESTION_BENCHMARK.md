# Local embedding benchmark and capacity assessment (Milestone 6D.1)

Measured on October 10, 2026. This run used local MiniLM inference for **nine** deterministic, previously uncached movies. It processed **23** chunks and wrote no embedding cache entry, ingestion checkpoint, or Astra document. No OpenAI request was made. The dataset fingerprint matched the M6C report: `978a967571378f711aa8f5aa47bc7a1fe8dd21b2dcb68fd6e4a2be22c9bc290c`.

## Host and method

| Item | Observation |
| --- | --- |
| CPU | AMD Ryzen 7 PRO 3700U, 8 logical CPUs |
| Runtime | Windows x64, Node.js v22.17.0 |
| System memory | 14,928,908,288 bytes |
| Model | `Xenova/all-MiniLM-L6-v2` at revision `751bff37182d3f1213fa05d7196b954e230abad9` |
| Vector validation | All nine outputs had 384 finite values and unit L2 norm |
| Model initialization | 1,117 ms, measured inside the pinned local model loader |
| Candidate planning | 52,492 ms, including model initialization, dataset/tokenizer planning, and cache inspection |
| RSS before loading / after planning / sampled peak | 77.9 MB / 241.2 MB / 332.4 MB |
| Inference wall time | 2,730 ms, including selected-record reinspection and aggregation |
| Inference CPU time | 9,734 ms user + 375 ms system across available cores |

The command selects three uncached records per band: short = one chunk, medium = two or three chunks, long = four to eight chunks. It ranks IDs with SHA-256 within each band. The eight-chunk sample ceiling limits benchmark work; it does not cap future movie content. Memory is process RSS sampled every 25 ms, so a brief peak between samples may be missed. Model files were loaded with remote downloads disabled.

| Band | Movie | Plot characters | Chunks | Measured movie inference |
| --- | --- | ---: | ---: | ---: |
| Short | Curry and Pepper | 389 | 1 | 100.1 ms |
| Short | Bhakshak | 595 | 1 | 93.5 ms |
| Short | The Knockout | 214 | 1 | 41.0 ms |
| Medium | Corvette K-225 | 2,101 | 3 | 281.9 ms |
| Medium | The Big Fisherman | 1,344 | 2 | 183.3 ms |
| Medium | Soldier in the Rain | 1,570 | 2 | 230.7 ms |
| Long | Sampathige Saval | 2,668 | 4 | 416.1 ms |
| Long | The King of Comedy | 3,026 | 4 | 396.2 ms |
| Long | Side Out | 4,026 | 5 | 573.6 ms |

The 23 chunk calls took 2,309 ms in total, or **9.96 observed chunks per second**. Movie totals include aggregation and small loop overhead. The three short movies took 41.0–100.1 ms each, medium movies 183.3–281.9 ms, and long movies 396.2–573.6 ms.

## Extrapolation to remaining work

The unchanged M6C preflight counted **1,090 missing embeddings and 3,113 chunks**. Multiplying these chunks by the measured mean chunk time gives **312 seconds (5 min 12 sec) of local chunk processing** on this host. Multiplying by the fastest and slowest individual observed chunk times gives **84–489 seconds (1 min 24 sec–8 min 9 sec)**. This is an observed-extremes range, **not a confidence interval or end-to-end completion forecast**. The fastest observed call was a short final chunk. The sample excludes plots needing more than eight chunks; long-tail work may run slower.

Model startup, the measured 52-second candidate-planning pass, future cache writes, retries, Astra calls, checkpoint persistence, thermal throttling, and competing CPU workloads are outside the inference-only extrapolation. The process used several CPU cores during inference; plan for CPU contention and measure peak memory during a later controlled rollout. Do not infer that the full 1,090-record run is authorized by this benchmark.

## Read-only Astra capacity check

`npm.cmd run db` connected successfully. The collection descriptor still reports `movies_local_384`, 384 dimensions, cosine metric, and no vectorization service. Read-only inventory found **10** records, and the M6C remote preflight reverified all ten document hashes, metadata, and vectors. No Astra mutation was performed. Account-specific consumption, quotas, remaining credits, and billing status were not available through these checks and must be verified in the Astra console.

**Blocking indexed-plot risk:** The live descriptor returned no selective indexing rule. DataStax documents that a collection created without one indexes all fields by default and that the behavior cannot be changed after creation. The Data API limits an indexed string to **8,000 UTF-8 bytes**. Eight of the 1,100 movie plots exceed that limit; the largest is **29,395 bytes**. These eight currently have no reusable local cache entry. Based on the documented default and the observed descriptor, their current full-plot document shape is incompatible with this collection's indexed-string limit. This is a documentation-based risk assessment; no prohibited test write was attempted. A future approved data-model and collection strategy must resolve it while preserving plot attribution and the existing ten documents. Do not automatically delete or recreate the collection. See [collection indexing](https://docs.datastax.com/en/astra-db-serverless/api-reference/collection-indexes.html) and [Data API limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html).

Other relevant Data API limits include a four-million-character document, a 20-million-character insert batch, at most 100 inserts per transaction, and 20-document pages for some reads. The current M6B writer sends one document at a time and enforces a document character bound. Before future execution, inspect complete serialized document sizes and collection indexing behavior. In the Astra console, confirm the account plan, usage/credits, active database status, collection/index capacity, request rate behavior, and monitoring availability. [Astra Serverless limits](https://docs.datastax.com/en/astra-db-serverless/databases/database-limits.html) describe free-plan database count limits, hibernation of inactive databases, and unavailable metrics export; these do not establish this account's remaining quota.

## Safety review and recommendation

- M6B continues to require `--apply` and caps an ordinary batch at ten records. M6C full execution remains disabled. This benchmark cannot write vectors or checkpoints.
- The existing sample checkpoint remains compatible. Verified and uncertain states still require remote readback before any future skip. M6B retries transient Astra failures at most three times and verifies writes remotely.
- Local cache identity includes source hash, provider, pinned model revision, chunk settings, and aggregation version. Checksums, vector dimensions, finite values, and unit norms are validated before production writes. The benchmark bypasses cache writes entirely.
- Wikipedia plot attribution and page-specific imported-text notices require review before broad distribution; see [ATTRIBUTION.md](ATTRIBUTION.md). Record `movie_dd0f87ec3b09193d2c11` has an empty genre; the current schema allows it, but product handling should be decided before full indexing.

**Recommendation: no-go for full ingestion now.** Resolve the eight oversized indexed plots and confirm the account's capacity and licensing path. Then obtain explicit approval for a separately gated execution milestone with measured monitoring, restart, and readback procedures. This 6D.1 benchmark does not enable that execution path.
