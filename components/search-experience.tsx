"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { MovieCard, type MovieResult } from "@/components/movie-card";
import { createSearchController, INITIAL_SEARCH_STATE, SEARCH_EXAMPLES, SEARCH_GENRES } from "@/lib/search-ui.mjs";

type SearchViewState = {
  status: "idle" | "loading" | "success" | "empty" | "invalid" | "error";
  query: string;
  results: MovieResult[];
  elapsedMs: number | null;
  error: string | null;
};

function SearchIcon({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" />
    </svg>
  );
}

function ResultsSkeleton() {
  return (
    <div className="results-grid" aria-hidden="true">
      {Array.from({ length: 6 }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <div className="skeleton-card__cover" />
          <div className="skeleton-card__line" />
          <div className="skeleton-card__line skeleton-card__line--short" />
        </div>
      ))}
    </div>
  );
}

export function SearchExperience() {
  const [query, setQuery] = useState("");
  const [genre, setGenre] = useState("");
  const [year, setYear] = useState("");
  const [topK, setTopK] = useState("10");
  const [searchState, setSearchState] = useState<SearchViewState>(INITIAL_SEARCH_STATE as SearchViewState);
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  const controllerRef = useRef<ReturnType<typeof createSearchController> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    controllerRef.current = createSearchController({
      onState: (next: SearchViewState) => setSearchState(next),
    });
    return () => {
      controllerRef.current?.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (searchState.status !== "loading") return;
    const started = performance.now();
    const interval = window.setInterval(() => setWaitingSeconds(Math.floor((performance.now() - started) / 1000)), 1000);
    return () => window.clearInterval(interval);
  }, [searchState.status, searchState.query]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setWaitingSeconds(0);
    void controllerRef.current?.submit({ query, genre, year, topK });
  }

  function handleExample(example: string) {
    setQuery(example);
    textareaRef.current?.focus();
  }

  return (
    <>
      <section className="search-panel" id="discover" aria-labelledby="search-heading">
        <div className="search-panel__intro">
          <div>
            <span className="section-kicker"><span className="kicker-line" /> YOUR MOVIE, YOUR MOOD</span>
            <h2 id="search-heading">What are you in the mood for?</h2>
          </div>
          <span className="search-panel__step">01 / DISCOVER</span>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          <label className="search-label" htmlFor="mood-query">Describe a feeling, scene, or story</label>
          <div className={`query-wrap${searchState.status === "invalid" ? " query-wrap--invalid" : ""}`}>
            <SearchIcon className="query-wrap__icon" />
            <textarea id="mood-query" ref={textareaRef} value={query}
              onChange={(event) => setQuery(event.target.value)} rows={3}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="A quiet, atmospheric mystery that stays with me after the credits..."
              aria-describedby="query-hint query-feedback"
              aria-invalid={searchState.status === "invalid"} />
            <span className="query-wrap__count">{Array.from(query).length} / 500</span>
          </div>
          <div className="query-below">
            <p id="query-hint">The more you describe the feeling, the better the search can connect the dots. Ctrl/⌘ + Enter to search.</p>
            <p id="query-feedback" className="form-error" role={searchState.status === "invalid" ? "alert" : undefined}>
              {searchState.status === "invalid" ? searchState.error : ""}
            </p>
          </div>

          <div className="examples" aria-label="Example descriptions">
            <span className="examples__label">TRY A PROMPT</span>
            <div className="examples__list">
              {SEARCH_EXAMPLES.map((example) => (
                <button key={example} type="button" onClick={() => handleExample(example)}>{example} <span aria-hidden="true">↗</span></button>
              ))}
            </div>
          </div>

          <div className="search-controls">
            <div className="filter-field">
              <label htmlFor="genre-filter">Genre</label>
              <select id="genre-filter" value={genre} onChange={(event) => setGenre(event.target.value)}>
                <option value="">Any genre</option>
                {SEARCH_GENRES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div className="filter-field">
              <label htmlFor="year-filter">Release year</label>
              <input id="year-filter" type="text" inputMode="numeric" maxLength={4}
                placeholder="Any year" value={year} onChange={(event) => setYear(event.target.value)} />
            </div>
            <div className="filter-field filter-field--count">
              <label htmlFor="result-count">Results</label>
              <input id="result-count" type="text" inputMode="numeric" maxLength={2}
                value={topK} onChange={(event) => setTopK(event.target.value)} aria-describedby="count-hint" />
              <span id="count-hint" className="sr-only">Choose 1 to 20 results</span>
            </div>
            <button className="search-submit" type="submit">
              <SearchIcon /> <span>{searchState.status === "loading" ? "Search again" : "Find my film"}</span>
              <span className="search-submit__arrow" aria-hidden="true">↗</span>
            </button>
          </div>
        </form>
      </section>

      <section className="results-section" aria-labelledby="results-heading" aria-busy={searchState.status === "loading"}>
        {searchState.status === "idle" && (
          <div className="empty-scene">
            <span className="empty-scene__symbol" aria-hidden="true">✳</span>
            <div>
              <span className="section-kicker">THE SCREEN IS YOURS</span>
              <h2 id="results-heading">A feeling is a good place to start.</h2>
              <p>Describe what you want to watch above. Your results will appear here, drawn from our real movie collection.</p>
            </div>
            <span className="empty-scene__index">02 / RESULTS</span>
          </div>
        )}

        {searchState.status === "invalid" && (
          <div className="state-panel" role="status">
            <span className="state-panel__icon" aria-hidden="true">✳</span>
            <h2 id="results-heading">A little more to go</h2>
            <p>Check the highlighted search field and filters, then try again.</p>
          </div>
        )}

        {searchState.status === "loading" && (
          <div className="loading-results">
            <div className="results-heading">
              <div><span className="section-kicker">SEARCHING THE COLLECTION</span>
                <h2 id="results-heading">Finding your kind of story<span className="loading-dots">...</span></h2></div>
              <span className="results-heading__meta">{waitingSeconds}s elapsed</span>
            </div>
            <p className="loading-note" role="status" aria-live="polite">We’re matching your description with the movie catalogue. This can take 8–20 seconds.</p>
            <ResultsSkeleton />
          </div>
        )}

        {searchState.status === "error" && (
          <div className="state-panel" role="alert">
            <span className="state-panel__icon" aria-hidden="true">↻</span>
            <span className="section-kicker">SEARCH INTERRUPTED</span>
            <h2 id="results-heading">The scene didn’t load.</h2>
            <p>{searchState.error}</p>
            <button type="button" onClick={() => void controllerRef.current?.retry()} className="state-panel__retry">Try this search again <span aria-hidden="true">↗</span></button>
          </div>
        )}

        {searchState.status === "empty" && (
          <div className="state-panel" role="status">
            <span className="state-panel__icon" aria-hidden="true">◇</span>
            <span className="section-kicker">NO MATCHES FOUND</span>
            <h2 id="results-heading">A different angle might help.</h2>
            <p>Try a broader description, another genre, or remove the exact year. The current collection is curated and incomplete.</p>
            <button type="button" onClick={() => textareaRef.current?.focus()} className="state-panel__retry">Refine your search <span aria-hidden="true">↗</span></button>
          </div>
        )}

        {searchState.status === "success" && (
          <div>
            <p className="sr-only" role="status">{searchState.results.length} films found for your search.</p>
            <div className="results-heading">
              <div><span className="section-kicker">CURATED FOR THIS SEARCH</span>
                <h2 id="results-heading">Stories worth a closer look<span className="heading-period">.</span></h2>
                <p className="results-heading__query">For “{searchState.query}”</p></div>
              <div className="results-heading__right"><span>{searchState.results.length} {searchState.results.length === 1 ? "film" : "films"} found</span>
                <small>{searchState.elapsedMs === null ? "" : `Completed in ${(searchState.elapsedMs / 1000).toFixed(1)}s`}</small></div>
            </div>
            <p className="score-note">Similarity scores show vector closeness, not a probability or personal compatibility percentage.</p>
            <div className="results-grid">
              {searchState.results.map((movie, index) => <MovieCard key={movie.id} movie={movie} index={index} />)}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
