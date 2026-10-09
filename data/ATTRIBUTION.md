# Movie dataset attribution

`movies.csv` is a cleaned, sampled adaptation of [Wikipedia Movie Plots by JustinR](https://www.kaggle.com/datasets/jrobischon/wikipedia-movie-plots), version 1 (October 15, 2018). The source dataset is listed by Kaggle as [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This derived CSV is distributed under the same license; this notice does not license the application code.

The plot text originated from Wikipedia contributors. Each row's `source_url` points to its article and its contributor history. Review the source article for any additional attribution notices before further redistribution.

Changes from the Kaggle source: normalized whitespace and Wikipedia URLs; excluded short plots, invalid source URLs, and duplicate movie identities; and selected 1,000 movies with decade and genre-group limits. Plot stories were not rewritten or truncated. The full raw download is not included in this repository.

## Recent movies (2019–2026)

`recent-movies.csv` is an adaptation of English Wikipedia film-article plot sections, retrieved through the [MediaWiki API](https://www.mediawiki.org/wiki/API:Parsing_wikitext). Film type, release dates, and genres were checked against [Wikidata](https://www.wikidata.org/). Each row's `source_url` links to the source article and its contributor history. Wikipedia contributors retain credit for their text. [Wikidata structured metadata is CC0](https://www.wikidata.org/wiki/Wikidata:Licensing). The CSV's article text is distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/), in accordance with the [Wikimedia Terms of Use](https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use). This notice applies to the dataset, not the application code.

Changes from source articles: selected only the Plot, Plot summary, Synopsis, or Story section; removed HTML markup, reference markers, parser citation-error notices, infoboxes, and other non-plot elements; normalized whitespace; and selected a limited set of movies across release years. Plots were not generated, summarized, or shortened to a character limit. Titles and genre labels come from Wikidata where available. The script checks each selected article's plot and lead sections for obvious non-free or copyright-warning markup and excludes flagged pages. It does not prove that every source article lacks an exceptional imported-text attribution requirement. Follow each `source_url` to its article history and page-specific notices when redistributing a row; review any exceptional notices separately. The API response cache is local and is not committed.

## Unified dataset

`all-movies.csv` is a deterministic combination of `movies.csv` and `recent-movies.csv`. It is distributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) for the Wikipedia article text. The source article URL in every row links to its contributor history. [Wikidata structured metadata is CC0](https://www.wikidata.org/wiki/Wikidata:Licensing). This notice does not license the application code.

Changes from the two source CSVs: whitespace normalization, selection of one complete record for each normalized Wikipedia article identity, deterministic ordering, and source-anchored ID disambiguation only if distinct articles have colliding IDs. Titles, years, genres, plots, and source URLs are copied together from the selected input record; plot prose is never rewritten or shortened. The current source snapshots have no cross-dataset duplicates or ID collisions. See [DATASET_REPORT.md](DATASET_REPORT.md) for counts and fingerprints.

The source-specific attribution and imported-text caveats above continue to apply. Review linked article histories and page-specific notices before further redistribution, especially after refreshing either source CSV.
