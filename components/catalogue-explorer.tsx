"use client";

import { useEffect, useRef, useState } from "react";
import { MovieCard, type MovieResult } from "@/components/movie-card";
import { CATALOGUE_GENRES } from "@/lib/catalogue.mjs";

type CataloguePage = { items: MovieResult[]; total: number; nextCursor: string | null; genre: string | null };

export function CatalogueExplorer({ initial }: { initial: CataloguePage }) {
  const [genre, setGenre] = useState("");
  const [page, setPage] = useState(initial);
  const [status, setStatus] = useState<"ready" | "loading" | "error">("ready");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; controller.current?.abort(); }, []);

  async function load(nextGenre: string, cursor = "") {
    generation.current += 1;
    const current = generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setStatus("loading");
    try {
      const params = new URLSearchParams({ limit: "12" });
      if (nextGenre) params.set("genre", nextGenre);
      if (cursor) params.set("after", cursor);
      const response = await fetch(`/api/movies?${params}`, { cache: "no-store", signal: abort.signal });
      if (!response.ok) throw new Error("Catalogue request failed.");
      const payload = await response.json();
      if (payload?.success !== true || !Array.isArray(payload.data?.items)) throw new Error("Invalid catalogue response.");
      if (current !== generation.current) return;
      setPage((previous) => cursor ? { ...payload.data, items: [...previous.items, ...payload.data.items] } : payload.data);
      setStatus("ready");
    } catch {
      if (current === generation.current) setStatus("error");
    }
  }

  function chooseGenre(nextGenre: string) {
    if (nextGenre === genre) return;
    setGenre(nextGenre);
    if (!nextGenre) { generation.current += 1; controller.current?.abort(); setPage(initial); setStatus("ready"); }
    else void load(nextGenre);
  }

  return <section className="catalogue-section" id="browse" aria-labelledby="browse-heading">
    <div className="section-heading"><div><span className="section-kicker">THE MOVIE COLLECTION</span>
      <h2 id="browse-heading">Find your next <em>frame of mind.</em></h2>
      <p>Explore real films from the validated catalogue. Order follows stable movie IDs, not popularity or recommendations.</p></div>
      <span className="section-heading__count">1,100 FILMS · MOVIES ONLY</span></div>
    <div className="genre-row" role="group" aria-label="Browse by genre">{["", ...CATALOGUE_GENRES].map((item) =>
      <button key={item || "all"} type="button" className={genre === item ? "is-active" : ""}
        aria-pressed={genre === item} onClick={() => chooseGenre(item)}>{item || "All films"}</button>)}</div>
    <div className="catalogue-toolbar"><p aria-live="polite">{status === "loading" ? "Opening the catalogue…" : status === "error" ? "The catalogue could not be loaded." : `${page.total.toLocaleString()} ${genre || "catalogue"} ${page.total === 1 ? "film" : "films"}`}</p><span>CATALOGUE ORDER / STABLE IDs</span></div>
    {status === "error" && <div className="catalogue-error" role="alert"><p>That shelf is unavailable right now. Your previous films are still here.</p><button type="button" onClick={() => void load(genre)}>Try again</button></div>}
    <div className="catalogue-grid" aria-busy={status === "loading"}>{page.items.map((movie, index) => <MovieCard key={movie.id} movie={movie} index={index} />)}</div>
    {status === "loading" && <p className="catalogue-loading" role="status">Loading films from the catalogue…</p>}
    {status === "ready" && page.items.length === 0 && <p className="catalogue-empty">No films in this selection.</p>}
    {status === "ready" && page.nextCursor && <button className="load-more" type="button" onClick={() => void load(genre, page.nextCursor ?? "")}>Explore more films <span aria-hidden="true">↗</span></button>}
  </section>;
}
