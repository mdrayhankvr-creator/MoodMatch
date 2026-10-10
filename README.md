# MoodMatch

MoodMatch is a planned semantic, vibe-based movie search application. The repository contains the Next.js starter page, a server-only Astra DB connection utility, historical and recent movie pipelines, and a unified CSV dataset. Search and database ingestion are not implemented yet.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, and Tailwind CSS 4
- Astra DB TypeScript SDK for future vector storage
- `@huggingface/transformers` for local CPU embeddings, with the OpenAI SDK available as an optional provider
- `csv-parser` for local CSV preparation and validation, `cheerio` for parsing MediaWiki API section HTML, and `dotenv` for scripts
- npm for package management

## Install

Use Node.js 22 and npm. From the project root, install the locked dependencies:

```bash
npm ci
```

If `.env.local` does not already exist, copy `.env.example` to `.env.local`, then add your own credentials to the local file. `.env.local` is ignored by Git. The starter page does not use these settings yet.

| Variable | Purpose |
| --- | --- |
| `ASTRA_DB_APPLICATION_TOKEN` | Astra DB application token |
| `ASTRA_DB_API_ENDPOINT` | Astra DB API endpoint |
| `ASTRA_DB_COLLECTION` | Collection name; example uses `movies` |
| `EMBEDDING_PROVIDER` | `local` (default) or `openai` |
| `LOCAL_EMBEDDING_MODEL` | Local model; currently `Xenova/all-MiniLM-L6-v2` |
| `OPENAI_API_KEY` | OpenAI API key; required only for OpenAI requests |
| `OPENAI_EMBEDDING_MODEL` | OpenAI model; defaults to `text-embedding-3-small` |

## Local development

```bash
npm run dev
npm run lint
npx tsc --noEmit
```

Open [http://localhost:3000](http://localhost:3000) after starting the development server. In PowerShell environments that block the npm script shim, use `npm.cmd` and `npx.cmd` in place of `npm` and `npx`.

## Movie dataset

The source is [Wikipedia Movie Plots by JustinR on Kaggle](https://www.kaggle.com/datasets/jrobischon/wikipedia-movie-plots), version 1, last updated October 15, 2018. Its `wiki_movie_plots_deduped.csv` contains 34,886 rows and plot descriptions from Wikipedia. The [Kaggle dataset metadata](https://www.kaggle.com/datasets/jrobischon/wikipedia-movie-plots) labels it **CC BY-SA 4.0**. That license permits redistribution and adaptation subject to [attribution, a change notice, and ShareAlike](https://creativecommons.org/licenses/by-sa/4.0/). The underlying text has Wikipedia contributors; each output row links to its article, whose history identifies contributors. [Wikimedia's terms](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use) note that imported material can carry additional attribution requirements. Review the linked article and its history before any downstream republication that needs fuller attribution.

`data/movies.csv` is a cleaned, sampled adaptation of that source and is distributed under **CC BY-SA 4.0**; this notice applies to the dataset, not the application code. See [data/ATTRIBUTION.md](data/ATTRIBUTION.md) for the notice beside the CSV. Changes: whitespace normalization, URL normalization, removal of short or invalid plots and duplicate movie identities, and deterministic selection across release decades and genre groups. Plot wording is otherwise preserved. The raw Kaggle download is ignored by Git. The committed output retains each Wikipedia page URL for source attribution.

### Download and prepare

Download the dataset from its Kaggle page or use the [official Kaggle CLI](https://github.com/Kaggle/kaggle-cli/blob/main/docs/datasets.md):

```bash
kaggle datasets download jrobischon/wikipedia-movie-plots -p data/raw --unzip
```

Kaggle may require a free account or API authentication. Place the extracted file at `data/raw/wiki_movie_plots_deduped.csv`. The preparation command also accepts a different raw CSV path as its first argument. The raw file is intentionally untracked.

```bash
npm run data:prepare
npm run data:validate
```

On Windows PowerShell, use `npm.cmd run data:prepare` and `npm.cmd run data:validate`. Preparation streams the 81,193,310-byte source CSV, keeps bounded candidates per decade and genre group, and replaces `data/movies.csv` only after a successful run. Repeating it with the same source produces identical bytes. It does not shorten long plots.

### Output schema

| Column | Meaning |
| --- | --- |
| `id` | Stable SHA-256-based ID from the normalized title and year, or the source URL when the year is absent |
| `title` | Movie title |
| `year` | Four-digit release year, or blank if absent |
| `genre` | Source genre text with whitespace normalized |
| `plot` | Wikipedia plot text with whitespace normalized |
| `source_url` | Canonical Wikipedia article URL |

The output contains **1,000 movies** from 33,308 valid unique source rows. Of 34,886 raw rows, 716 had plots below the 120-character and 20-word minimum, one lacked a valid Wikipedia article URL, and 861 were duplicate identities. No title, plot, or year fields were missing or invalid in this source snapshot. Plot length in the output ranges from 126 to 29,395 characters, with a median of 1,639. The largest selected decade is the 2010s (173 movies), and the largest genre group is drama (225). Genre groups are used only for sampling; the original genre text is retained in the CSV.

The source snapshot was downloaded from the official Kaggle API. Its CSV SHA-256 is `e5450142ff22420ec2229ab1ee5a567e771f001fc04acd7960b533c88e5993c`. This pipeline samples at most 1,000 movies; it is not a complete catalogue. Short early-film plots and records without attributable article URLs are excluded, and title-plus-year identity may collapse distinct films sharing both values.

## Recent movie dataset

`data/recent-movies.csv` uses the same six-column schema as the historical dataset. Its source is English Wikipedia film-article plot sections retrieved with the [MediaWiki API](https://www.mediawiki.org/wiki/API:Parsing_wikitext). The pipeline checks the linked [Wikidata](https://www.wikidata.org/) item for film type (`P31`), release date (`P577`), and genre (`P136`). Each row retains its Wikipedia article URL for attribution and contributor history. The acquisition date can be fixed with `--as-of` so reruns select the same snapshot from the local API cache.

The source article text is available under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) subject to attribution, change notice, and ShareAlike; [Wikidata's structured metadata is CC0](https://www.wikidata.org/wiki/Wikidata:Licensing). [Wikimedia's Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use) also caution that imported material can carry additional requirements. See [data/ATTRIBUTION.md](data/ATTRIBUTION.md) for the dataset notice and modification summary. The script checks both plot and lead sections and skips obvious non-free or copyright-warning markup; automated checks still cannot establish rights for every excerpt. Review source-page notices before downstream redistribution.

### Fetch and validate recent movies

```bash
npm run data:fetch-recent -- --max 100 --as-of 2026-10-09
npm run data:recent
```

Use `npm.cmd` on PowerShell installations that block npm's script shim. `--max` accepts 1–1,000. `--candidate-limit` controls how many category pages per year are considered (100–5,000; default 1,000), and `--refresh` bypasses cached API responses. API requests are sequential, at least 500 ms apart, use a project-identifying User-Agent and `maxlag`, and retry transient failures with bounded backoff. Responses are cached under ignored `data/cache/wikimedia/`; the CSV is replaced only after a successful run. Identical cache and command options yield identical CSV bytes. Refreshing can change the output as Wikipedia or Wikidata changes.

Discovery uses the 2019–2026 film categories, samples candidates deterministically, checks Wikidata metadata, then extracts a Plot, Plot summary, Synopsis, or Story section. It excludes pages without a usable section, unverifiable release year, film type, or genre, and plots below 120 characters or 20 words. It removes markup and reference markers, normalizes whitespace, and caps one release year at 25% of the selected set. Plot prose is preserved without AI rewriting or length truncation. Category membership, Wikidata claims, and article sections can be incomplete or change over time. The default discovery examines only the first 1,000 category members per year before the stable sample, so it is not a complete or statistically representative catalogue. Genre labels are Wikidata labels, not a controlled taxonomy; future-dated films are excluded as of the requested date.

The committed snapshot uses `--as-of 2026-10-09 --max 100 --candidate-limit 1000`. It discovered 8,000 category pages, sampled 1,200 candidates, and retained **100 movies**: 2019–2021 and 2025 have 15 each; 2022–2024 and 2026 have 10 each. Among checked candidates, 68 lacked a verified film claim, 393 lacked a release-date claim, 36 had no matching release year, 144 lacked genre claims, 48 lacked a suitable plot section, four had short plots, and one repeated a verified identity. All selected lead sections were available, and no checked lead or plot section triggered the copyright-warning filter. Plot lengths range from 121 to 9,493 characters (median 1,541). The CSV SHA-256 is `7bd62c8ec47739dee977995dcd2f32905080d1deeba00e7144c26506e33f922c`; a cached rerun produced identical bytes. The plot exclusion counts stop once the target of 100 is reached, so they are not exhaustive counts for all 1,200 sampled pages.

## Unified movie dataset

`data/all-movies.csv` combines the validated historical and recent files with the same `id,title,year,genre,plot,source_url` schema. The generated [dataset report](data/DATASET_REPORT.md) records input counts, exclusions, year and genre distribution, plot lengths, and file hashes. The current snapshot has **1,100 movies**: 1,000 historical and 100 recent records, with no cross-dataset duplicates.

```bash
npm run data
npm run data:all
```

`npm run data` only merges the two committed source CSVs; it does not call external APIs or rewrite them. `data:all` checks CSV encoding and fields, ID and article uniqueness, year and URL validity, full source-record preservation, and coverage of both inputs. On Windows PowerShell, use `npm.cmd`. Identical inputs produce identical output and report bytes. The merger keeps existing IDs when unique. If two distinct articles share an input ID, both receive deterministic IDs derived from their source article identities. Records sharing a title and year remain separate when their article identities differ.

To add verified movies later, update the appropriate source CSV through its documented acquisition pipeline or add a properly attributed row using the existing six-column schema. Use the `movieId` helper in `scripts/movie-data.mjs` for an ordinary row; use `sourceMovieId` if another film has the same title and year. Run `npm run data:validate` for historical changes or `npm run data:recent` for recent changes, then run `npm run data` and `npm run data:all`. The historical source preparation command remains `npm run data:prepare` and requires the ignored Kaggle raw download. The recent acquisition command remains `npm run data:fetch-recent`; it uses Wikimedia APIs and may update the recent source snapshot. Review the generated report and attribution notice before redistributing changed plots.

The unified CSV is an adaptation of the two source datasets and is distributed under **CC BY-SA 4.0** for the Wikipedia article text. Each row retains its article URL and contributor history; [data/ATTRIBUTION.md](data/ATTRIBUTION.md) records the change notice and exceptional licensing caveat. Source articles and metadata can change, and the combined set is a curated sample rather than a complete film catalogue. The offline merge does not resolve different redirect URLs that point to the same article.

## Embedding providers

The server-only `lib/embeddings.ts` exposes `embedText`, `embedBatch`, provider/model IDs, dimensions, and a content hash that includes the provider and model. It uses `EMBEDDING_PROVIDER=local` by default. Both providers use the same stable `Title`, optional `Genre`, and full `Plot` input format. An OpenAI key is unnecessary in local mode. The local model is loaded only when first used and reused for later requests. The local model is imported dynamically on the server; client components must not import this service.

The local provider uses [`Xenova/all-MiniLM-L6-v2`](https://huggingface.co/Xenova/all-MiniLM-L6-v2), licensed **Apache 2.0**, with mean pooling and normalization to produce **384-dimensional** vectors. It runs on the CPU in Node.js on Windows; first use downloads model files from Hugging Face into the ignored `node_modules/@huggingface/transformers/.cache/` directory. The initial download was about **87 MiB** in this environment. Later runs use that cache. A network connection and adequate disk space are needed for the first run; CPU inference time varies by machine. Model artifacts are not committed.

```bash
npm run embeddings:local
npm run test:offline
```

`embeddings:local` analyzes all 1,100 movie inputs with the model tokenizer, writes the deterministic [local input report](data/LOCAL_INPUT_REPORT.md), and embeds a stable sample of five eligible, genuine records. It prints only movie IDs, vector dimensions, and elapsed processing times. `--limit 1..5` can reduce the sample. It makes no OpenAI calls or Astra DB writes and does not store vectors. The current report finds **419** inputs that fit in full and **681** that require chunking. This original M5A command still rejects inputs above **256 tokens**, including special tokens, before inference. The [underlying model card](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) says longer inputs are normally truncated; this limit prevents a partial plot from being represented as a full one. The M5B commands below handle long plots through verified chunking. Dataset plot text remains unchanged.

Vector collections must remain separate by model and dimension: use `movies_local_384` for local vectors and `movies_openai_1536` for OpenAI vectors when ingestion is implemented. No collection is created by these scripts.

### Tokenizer-aware local chunking and cache

The local model is pinned to Hugging Face revision `751bff37182d3f1213fa05d7196b954e230abad9`. Its input safety limit remains **256 tokens including special tokens**. `lib/chunking.mjs` splits the normalized plot at Unicode grapheme boundaries, preferring punctuation or whitespace near each boundary. It aims for at most **220 plot tokens per chunk** with about **20 tokens of context overlap**, allowing for the repeated title and genre prefix. The exact MiniLM tokenizer verifies every final input before inference. Non-overlapping core spans concatenate to the complete normalized plot, so no plot content is silently truncated. An input whose prefix and even one grapheme cannot fit fails explicitly.

The chunking and aggregation functions accept general title, optional genre, and description fields; future TV-series descriptions can use the same pipeline with their own stable record IDs. Each chunk receives a real 384-dimensional local embedding. Aggregation weights each chunk by the number of non-whitespace Unicode code points in its **unique core span**, excluding overlap from the weight, then L2-normalizes the combined vector. This is a deterministic approximation: a single vector can still blur distinct parts of a long plot, and repeated title/genre context appears in each chunk.

```bash
npm run embeddings:build:dry-run
npm run embeddings:build:sample
npm run embeddings:build:sample
```

The dry run tokenizes all 1,100 movies and reports estimated chunks and token compliance without inference or vector writes. The current dataset yields **3,140 chunks**, including the **681** long inputs identified above; no assembled chunk exceeds 256 tokens. The sample command selects five stable real IDs, including two long plots, and saves only their local vectors in ignored `data/cache/embeddings/local/`. Run it twice: the first run builds missing entries and the second reports cache hits without repeat inference. `--limit 2..5` is supported for the sample; full-dataset inference is disabled in this milestone. Neither command calls OpenAI or Astra DB. A first run can download the pinned model revision and needs network access, CPU time, and local disk space.

Cache files use stable record IDs and SHA-256 keys over normalized source text, provider, model, pinned revision, chunk settings, and aggregation version. Each file stores the normalized-source hash, 384-dimensional vector, chunk count, and chunk metadata. Entries are checked for matching identity, dimensions, finite values, unit norm, and integrity before reuse; invalid entries are rebuilt. Files are written through a temporary file and atomic rename, so an interrupted write does not become a valid cache hit. To rebuild after a source, model, or configuration change, rerun the sample command; the changed identity creates a new entry. To discard obsolete local entries, remove only the ignored `data/cache/embeddings/local/` directory after checking its path. Cache paths reserve separate provider namespaces; this command writes only to the local namespace. Generated vectors and model artifacts are not committed.

### Controlled Astra DB ingestion (Milestone 6)

The server-only local vector store uses collection `movies_local_384`, configured for **384 dimensions**, **cosine** similarity, and client-supplied vectors. It checks existing collection settings before any write and refuses incompatible dimensions, metric, or Astra-managed vectorization. OpenAI vectors belong in a separate future collection, `movies_openai_1536`; these commands never call OpenAI or write to that collection.

```bash
npm run db:ingest:dry-run
npm run db:ingest:sample
npm run db:vector:test
npm run db:ingest:sample
```

On Windows use `npm.cmd run ...`. Dry-run is the default when running `scripts/ingest-movies.mjs` directly. It tokenizes and checks a deterministic sample of five real movies, including two long plots, and reports cache status, chunk counts, and planned IDs. It makes no database writes or inference calls and does not need Astra credentials. `--apply` is required to create the collection and upsert documents; `--limit` only accepts 2–5. The apply command loads `.env.local` locally, creates the collection only if missing, and uses cached local embeddings or generates missing local embeddings. It never processes the whole dataset.

Each document uses the stable movie ID as `_id` and stores the full plot, source article URL, year, genre, `content_type=movie`, content SHA-256, provider, model revision, aggregation/chunk version, chunk count, and a 384-dimensional vector. An unchanged, valid remote document is skipped. Source URL or year corrections with the same embedding identity update metadata without rewriting the vector. Changed content or model versions cause an upsert at the same ID. Every successful upsert is read back with explicit `$vector` projection and checked for metadata, dimensions, finite values, and unique ID. Run apply a second time to confirm unchanged records are skipped. The similarity check searches with one stored sample vector and prints at most five IDs, titles, and scores; this small sample cannot establish recommendation quality.

The sample's complete Wikipedia plots and metadata retain the attribution and **CC BY-SA 4.0** obligations described in [data/ATTRIBUTION.md](data/ATTRIBUTION.md). Database copies and any downstream display must preserve article links, contributor attribution, change notices, and ShareAlike terms where applicable. Review exceptional article notices before broader distribution. A future full-dataset ingestion needs explicit authorization, batching, resumability, budget and quota controls, and per-record licensing review; this CLI deliberately caps writes at five movie IDs.

### Resumable local batch ingestion (Milestone 6B)

The batch command validates all 1,100 unified movie IDs and orders them deterministically: the existing five-record sample comes first, followed by SHA-256-ranked IDs. **This milestone permits at most ten movie IDs per apply run.** The dry run reports the selected records, local cache state, chunk estimate, and a full-dataset batch-count *estimate* without calling Astra DB, running inference, or writing vectors.

```bash
npm run db:batch:dry-run
npm run db:batch:sample
node scripts/ingest-batch.mjs --apply --limit 10 --batch-size 5 --infer-missing --resume
```

Use `npm.cmd` in PowerShell if npm's script shim is blocked. The CLI defaults to dry-run. `--apply` is mandatory for database writes; `--limit` and `--batch-size` each accept only 1–10, with a default of 10. `--infer-missing` explicitly permits **local CPU inference** for absent cache entries and is included in `db:batch:sample`. Without it, a cache miss fails that record. Corrupt cache entries are rejected even when inference is enabled. The batch command uses the existing `movies_local_384` collection and refuses to create, drop, or reconfigure it. No OpenAI request is made.

The document builder checks the SHA-256 hash of the current normalized title, genre, and plot against the embedding's cache provenance. That provenance must match the local provider, pinned model revision, 384 dimensions, tokenizer chunk settings, and aggregation version; the vector and chunk metadata must match the cache integrity checksum. Invalid dimensions, nonfinite values, or a non-unit vector are rejected before any write. Changed source content has a new cache identity and cannot reuse an old vector. The existing five-record command remains available.

Writes are sequential, with a 100 ms interval between records. Transient Astra failures receive at most three attempts with bounded exponential delays. After an uncertain write, the pipeline reads the document remotely before considering another upsert. Every successful or skipped document is read back by ID and checked for metadata, hash, vector validity, agreement with the validated cache vector within float precision, and unique ID. Data API documents above four million JSON characters are rejected; this command sends one document per write rather than bulk inserts, staying below the [published Data API batch limits](https://docs.datastax.com/en/astra-db-serverless/api-reference/dataapi-limits.html).

Progress is recorded after each record in ignored `data/cache/ingestion/local-movies-384.json` through a temporary file and atomic rename. The checkpoint includes hashes of the CSV bytes and ingestion configuration, per-record outcomes, and only fully verified batch completions. `--resume` verifies claimed successes against Astra before skipping them; a missing or mismatched remote document is repaired through the normal upsert path. An incompatible or corrupt checkpoint fails closed. To start anew after a dataset or configuration change, review the change and run without `--resume`; this replaces the local state file. It does not delete remote documents.

CPU inference time depends on plot length and chunk count; network latency, retries, and Astra consumption can add time and cost. The ten-record sample contains five previously ingested movies and up to five new local embeddings. This milestone exposes no full-dataset apply mode. Before a future 1,100-record run, obtain explicit approval for the expanded write scope, review source licensing and Astra capacity/costs, and add operational monitoring. The Wikipedia plot attribution and CC BY-SA 4.0 obligations in [data/ATTRIBUTION.md](data/ATTRIBUTION.md) still apply to database copies and downstream display.

### Full dataset readiness preflight (Milestone 6C)

```powershell
npm.cmd run db:preflight
npm.cmd run db:preflight:remote
```

The default preflight validates all 1,100 movie IDs and source identities, current content hashes, the pinned local model, tokenizer chunk counts, and cache checksums. It loads the local model with downloads disabled but performs no inference, database access, or writes. The `--remote-read-only` variant additionally checks the existing Astra collection and verifies stored records against valid local cache vectors. The report includes cache coverage, missing chunks, existing documents, candidate future writes, optional metadata gaps, and observed memory. See [data/INGESTION_READINESS.md](data/INGESTION_READINESS.md) for the latest reviewed snapshot and source licensing limits.

Full ingestion remains disabled. The planner describes small batches (at most ten) and bounded concurrency (at most two); neither preflight command accepts `--apply`. M6B's ten-record cap remains in force. A future, separately approved execution milestone must add an explicit gate and write path, preserve provider and provenance validation before every write, infer missing embeddings only with explicit authorization, and read back every result. Its separate versioned checkpoint must include dataset/configuration fingerprints and per-record progress. On interruption, stop scheduling, preserve uncertain outcomes, then reconcile against Astra before skipping or retrying. The existing M6B sample checkpoint is read without modification and cannot authorize a full run. Monitor per-batch completions, failures, retries, cache use, and remote verification; confirm Astra account limits and application-level monitoring before enabling writes.

### Local inference benchmark (Milestone 6D.1)

Run `npm.cmd run embeddings:benchmark` to measure the pinned local model on nine deterministic, uncached movies: three short, three medium, and three long plots. The command validates each 384-dimensional output and prints model startup, per-movie and per-chunk timings, observed throughput, sampled peak RSS, and an explicitly labeled inference-only extrapolation. It accepts no options, makes no Astra or OpenAI requests, and writes no embeddings or checkpoints. The measured results and the read-only Astra capacity assessment are in [data/INGESTION_BENCHMARK.md](data/INGESTION_BENCHMARK.md). Full ingestion remains disabled; the report identifies an indexed-plot size blocker requiring a future approved design decision.

### Versioned local vector schema (Milestone 6D.2)

Run `npm.cmd run db:schema-v2` for an offline UTF-8 size and selective-indexing assessment of all 1,100 movies. [data/VECTOR_SCHEMA_V2.md](data/VECTOR_SCHEMA_V2.md) defines the `movies_local_384_v2` collection with complete plots stored outside metadata indexing and a guarded descriptor validator. This command performs no inference or database operation. The collection now contains the ten verified legacy sample movies; full ingestion remains disabled.

### V2 migration preparation (Milestones 6D.3A and 6D.3B)

Run `npm.cmd run db:migrate-v2:dry-run` to verify the ten legacy records and local cache entries, inspect v2 by ID, and print a read-only plan. The authorized seven-record resume on October 11, 2026 completed the ten-record sample migration. Independent read-only verification found exactly ten expected v2 IDs, matching complete plots, source URLs, hashes, provenance, and 384-dimensional vectors; genre, year, content-type, and vector similarity queries passed. The hardcoded apply gate is closed again, and `--apply --confirm-v2-migration` refuses before database access. [data/VECTOR_MIGRATION_EXECUTION.md](data/VECTOR_MIGRATION_EXECUTION.md) records the results; [data/VECTOR_MIGRATION_PLAN.md](data/VECTOR_MIGRATION_PLAN.md) retains the recovery history and rollback procedure. The default dry-run makes no writes or inference calls, and search still uses the legacy collection.

### Full local movie ingestion preparation

Run `npm.cmd run db:ingest-full-v2` for the default read-only plan against all 1,100 source movies and the existing `movies_local_384_v2` collection. The October 11 dry-run found 10 exact matches, 1,090 missing records, no conflicts, and 3,113 chunks requiring local inference. It made no embeddings or database/checkpoint writes. A separate full-ingestion hardcoded gate remains **closed**; even `--apply --confirm-full-ingestion` is rejected before credentials or database access. The future implementation uses checksum-valid local cache entries, sequential create-only inserts, bounded read-only reconciliation, exact readback, and a separate atomic checkpoint. [data/FULL_V2_INGESTION_PLAN.md](data/FULL_V2_INGESTION_PLAN.md) records the design, measured dry-run, capacity unknowns, and source-rights blockers. Search still selects the legacy collection by default.

### OpenAI option

Set `EMBEDDING_PROVIDER=openai` and `OPENAI_API_KEY` in ignored `.env.local` for server-side OpenAI use. `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-small`; the service also accepts `text-embedding-3-large` with an explicit 1,536-dimension output. The existing OpenAI retry and validation logic remains in place. The separate OpenAI sample commands below explicitly select that provider; running the local command never selects it.

```bash
npm run embeddings:dry-run
npm run test:offline
npm run embeddings:test
```

The dry run needs no API key. It selects five actual, deterministic records from `data/all-movies.csv`, formats each input as `Title`, optional `Genre`, and `Plot`, and reports a one-call plan. The live command makes **one batched OpenAI embeddings request** for at most five movies and prints IDs, titles, vector dimensions, and the API's aggregate input-token usage. It does not save vectors or write to Astra DB. Both commands require `--limit 1..5` when invoking `scripts/test-embeddings.mjs` directly; only `--live` enables network requests. Confirm API billing and quota before running the live command. A ChatGPT subscription does not cover API usage. The M5 OpenAI live test returned a quota or billing error, so that integration remains unverified; M5A did not make a paid API request.

The OpenAI service rejects empty text, batches above 2,048 inputs, and text or batches whose UTF-8 byte counts exceed the 8,192-token per-input or 300,000-token per-request ceilings. Byte counts are conservative token upper bounds, not exact token counts; some valid long inputs may be rejected. Plots are never truncated. The sample script reports how many source rows exceed that safety bound. API rate limits, timeouts, and transient server errors receive at most two retries with bounded backoff; authentication and quota errors fail immediately. For future incremental embedding updates, `embeddingContentHash` hashes the provider, model, and formatted input, so content or model changes produce a new key.

The [official OpenAI model pricing](https://developers.openai.com/api/docs/models/text-embedding-3-small) lists `text-embedding-3-small` at **$0.02 per 1 million input tokens** as of October 2026. Estimate a direct embedding request as `actual input tokens × 0.02 / 1,000,000` USD, excluding any applicable taxes or other account charges. The live script reports the actual token count; the dry run reports only a conservative ceiling. Recheck current pricing before estimating a different model or a later run. [OpenAI's embeddings guide](https://developers.openai.com/api/docs/guides/embeddings) documents the 1,536-dimension default, and the [API reference](https://developers.openai.com/api/reference/resources/embeddings/methods/create) documents request limits.
