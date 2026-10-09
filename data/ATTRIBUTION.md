# Movie dataset attribution

`movies.csv` is a cleaned, sampled adaptation of [Wikipedia Movie Plots by JustinR](https://www.kaggle.com/datasets/jrobischon/wikipedia-movie-plots), version 1 (October 15, 2018). The source dataset is listed by Kaggle as [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). This derived CSV is distributed under the same license; this notice does not license the application code.

The plot text originated from Wikipedia contributors. Each row's `source_url` points to its article and its contributor history. Review the source article for any additional attribution notices before further redistribution.

Changes from the Kaggle source: normalized whitespace and Wikipedia URLs; excluded short plots, invalid source URLs, and duplicate movie identities; and selected 1,000 movies with decade and genre-group limits. Plot stories were not rewritten or truncated. The full raw download is not included in this repository.
