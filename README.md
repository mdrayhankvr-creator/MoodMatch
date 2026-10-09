# MoodMatch

MoodMatch is a planned semantic, vibe-based movie search application. The repository contains the Next.js starter page, a server-only Astra DB connection utility, and a local movie dataset preparation pipeline. Search and database ingestion are not implemented yet.

## Tech stack

- Next.js 16 (App Router), React 19, TypeScript, and Tailwind CSS 4
- Astra DB TypeScript SDK for future vector storage
- OpenAI SDK for future embeddings
- `csv-parser` for local CSV preparation and validation, and `dotenv` for scripts
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
npm run data
npm run data:validate
```

On Windows PowerShell, use `npm.cmd run data` and `npm.cmd run data:validate`. Preparation streams the 81,193,310-byte source CSV, keeps bounded candidates per decade and genre group, and replaces `data/movies.csv` only after a successful run. Repeating it with the same source produces identical bytes. It does not shorten long plots.

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
