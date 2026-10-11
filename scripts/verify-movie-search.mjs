import { getAstraDbRuntime } from "../lib/astra-runtime.mjs";
import { loadIngestionEnvironment } from "../lib/ingestion-environment.mjs";
import { createMovieSearchService } from "../lib/movie-search.mjs";

// Fixed review queries only. This command performs local inference and Astra reads.
const cases = [
  { label: "thriller", query: "A psychological thriller with an unexpected ending", topK: 5 },
  { label: "friendship", query: "A heartwarming story about friendship and family", topK: 5 },
  { label: "science_fiction", query: "A mysterious science fiction movie involving time", topK: 5 },
  { label: "survival", query: "An intense survival adventure", topK: 5 },
  { label: "genre_drama", query: "A moving family story", topK: 5,
    filters: { genre: "drama" } },
  { label: "year_2019", query: "A mysterious movie", topK: 5,
    filters: { year: 2019 } },
  { label: "combined", query: "A dramatic family story", topK: 5,
    filters: { genre: "drama", year: 2013 } },
];

if (process.argv.length !== 2) {
  console.error("The read-only search verification command accepts no arguments.");
  process.exitCode = 1;
} else {
  try {
    const db = getAstraDbRuntime(loadIngestionEnvironment());
    const searchMovies = createMovieSearchService({ db });
    const observations = [];
    for (const sample of cases) {
      const response = await searchMovies({ query: sample.query, topK: sample.topK,
        filters: sample.filters });
      if (!response.results.length || response.results.length > sample.topK ||
          response.results.some((result) => result.contentType !== "movie" ||
            !Number.isFinite(result.similarityScore) ||
            (sample.filters?.genre && result.genres.join(", ") !== sample.filters.genre) ||
            (sample.filters?.year && result.year !== sample.filters.year) ||
            Object.keys(result).some((key) => ![
              "id", "title", "year", "genres", "contentType", "sourceUrl", "similarityScore",
            ].includes(key)))) {
        throw new Error("Live search returned incomplete results, an unapplied filter, or internal fields.");
      }
      observations.push({ label: sample.label, query: sample.query,
        filters: sample.filters ?? { content_type: "movie" },
        retrieved: response.results.length, timings: response.timings,
        topResults: response.results.slice(0, 3).map(({ id, title, similarityScore }) =>
          ({ id, title, similarityScore })) });
    }
    console.log(JSON.stringify({ mode: "read-only", databaseWrites: 0,
      inferenceProvider: "local", collection: "movies_local_384_v2", observations }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ code: error?.code ?? "SEARCH_VERIFICATION_FAILED",
      message: typeof error?.code === "string" ? error.message :
        "Search verification could not start. Check local model and Astra configuration." }));
    process.exitCode = 1;
  }
}
