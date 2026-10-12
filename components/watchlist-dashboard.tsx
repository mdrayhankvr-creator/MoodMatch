"use client";

import Link from "next/link";
import { useState } from "react";
import { MovieCard } from "./movie-card";
import { usePersonal } from "./personal-provider";

export function WatchlistDashboard() {
  const personal = usePersonal();
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  if (personal.status !== "ready") return <p className="personal-note" role="status">{personal.status === "error" ?
    "Your watchlist could not be loaded. Please refresh this page." : "Loading your watchlist…"}</p>;
  const items = personal.summary.movies.filter((movie) => movie.watchlistedAt)
    .sort((a, b) => (b.watchlistedAt ?? "").localeCompare(a.watchlistedAt ?? ""));
  async function remove(id: string) {
    setBusyId(id); setError("");
    try {
      const response = await fetch(`/api/personal/movies/${id}`, { method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ watchlisted: false }) });
      if (!response.ok) throw new Error("Unavailable");
      await personal.refresh();
    } catch { setError("Could not remove that film. Please try again."); }
    finally { setBusyId(""); }
  }
  return <div className="personal-page__content"><span className="section-kicker">SAVED FOR LATER</span><h1>Want to watch</h1>
    <p>Your private list of films to explore next.</p>
    {error && <p className="personal-error" role="alert">{error}</p>}
    {items.length ? <div className="watchlist-grid">{items.map((movie, index) => <div key={movie.id}>
      <MovieCard movie={movie} index={index} /><button type="button" disabled={busyId === movie.id}
        onClick={() => void remove(movie.id)}>{busyId === movie.id ? "Removing…" : "Remove from watchlist"}</button>
    </div>)}</div> : <p className="personal-empty">Your watchlist is empty. <Link href="/#browse">Browse films</Link> to save one.</p>}
  </div>;
}
