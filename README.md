# MoodMatch

MoodMatch is a planned semantic, vibe-based movie search application. The repository contains the Next.js starter page, a server-only Astra DB connection utility, historical and recent movie pipelines, and a unified CSV dataset. Search and database ingestion are not implemented yet.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, and Tailwind CSS 4
- Astra DB TypeScript SDK for future vector storage
- OpenAI SDK for future embeddings
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
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_EMBEDDING_MODEL` | Embedding model name; example uses `text-embedding-3-small` |

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
