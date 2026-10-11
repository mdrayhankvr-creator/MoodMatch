# Premium discovery UI: catalogue and artwork decisions

## Catalogue source

The homepage and `GET /api/movies` read the versioned, validated `data/all-movies.csv` source snapshot. This is the same 1,100-ID source set independently verified in `movies_local_384_v2` at the end of M6. The server validates the full source before projecting only stable ID, title, year, genre, content type, safe Wikipedia source URL, and approved artwork metadata. No plot, vector, hash, model provenance, or credential is returned. Detail routes perform exact ID lookup against this same snapshot. Browse order is stable ID order, with a bounded cursor and a maximum page size of 24. These pages do not query Astra or claim live database membership if the source or collection changes later.

## Artwork decision

**Current real poster coverage: 0 / 1,100.** The site uses original CSS graphic placeholders with fixed aspect ratios. These are labelled as MoodMatch artwork in film details. No remote image host is allowed in Next.js configuration, and no image files were downloaded or committed.

TMDB's [API Terms of Use](https://www.themoviedb.org/api-terms-of-use) restrict use of TMDB APIs or content in connection with AI-based applications; its [FAQ](https://developer.themoviedb.org/docs/faq) also states attribution and non-commercial conditions for free API use. We therefore do not integrate TMDB imagery or data without a separate agreement and review.

[Wikimedia Commons reuse guidance](https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia) requires checking each image's file page, creator, license, attribution conditions, and possible non-copyright restrictions. A Wikipedia article or Commons listing alone does not establish that a particular movie poster can be reused here. `selectApprovedArtwork` accepts only exact movie-ID manifest entries with a local file path, creator, file page, and an allowed license. The approved manifest is intentionally empty until an individual file review is completed. Artwork must be matched by a reliable identifier or disambiguated title and year, never title alone.

## Remaining rights and deployment work

- Article-level rights for redistributing full Wikipedia plot text remain unresolved; the UI withholds it.
- The source article link preserves attribution context, but an exhaustive article-level licensing audit is still needed before public redistribution.
- Public deployment still needs authentication or distributed rate limiting and capacity review for the search API. Client cancellation stops waiting for a response but does not cancel underlying Astra work.
