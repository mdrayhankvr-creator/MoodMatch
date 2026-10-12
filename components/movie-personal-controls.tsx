"use client";

import Link from "next/link";
import { useState } from "react";
import { usePersonal } from "./personal-provider";

export function MoviePersonalControls({ id }: { id: string }) {
  const personal = usePersonal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (personal.status === "unavailable") return <p className="personal-note">Personal tracking is unavailable until Supabase is configured.</p>;
  if (personal.status === "loading") return <p className="personal-note" role="status">Loading your movie lists…</p>;
  if (personal.status === "error") return <p className="personal-note" role="alert">Your lists could not be loaded. <button type="button" onClick={() => void personal.refresh()}>Try again</button></p>;
  if (personal.status === "guest") return <p className="personal-note"><Link href={`/login?next=${encodeURIComponent(`/movie/${id}`)}`}>Sign in with Google</Link> to track, save and rate this film.</p>;
  if (!personal.summary) return null;
  const status = personal.summary.movies.find((movie) => movie.id === id);
  const watched = Boolean(status?.watchedAt);
  const watchlisted = Boolean(status?.watchlistedAt);
  async function update(patch: Record<string, boolean | number | null>) {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/personal/movies/${id}`, { method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch), cache: "no-store" });
      if (!response.ok) throw new Error("Could not save this film. Please try again.");
      await personal.refresh();
    } catch { setError("Could not save this film. Please try again."); }
    finally { setBusy(false); }
  }
  return <section className="personal-controls" aria-label="Your movie activity">
    <h2>Your movie</h2>
    <div className="personal-controls__buttons">
      <button type="button" disabled={busy} aria-pressed={watched} onClick={() => void update({ watched: !watched })}>
        {watched ? "✓ Watched" : "Mark watched"}</button>
      <button type="button" disabled={busy} aria-pressed={watchlisted} onClick={() => void update({ watchlisted: !watchlisted })}>
        {watchlisted ? "✓ In watchlist" : "Want to watch"}</button>
    </div>
    <label htmlFor="personal-rating">Your rating</label>
    <select id="personal-rating" disabled={busy || !watched} value={status?.rating ?? ""}
      onChange={(event) => void update({ rating: event.target.value ? Number(event.target.value) : null })}>
      <option value="">No rating</option>
      {Array.from({ length: 10 }, (_, index) => index + 1).map((score) => <option key={score} value={score}>{score} / 10</option>)}
    </select>
    {!watched && <p className="personal-note">Mark the film watched before rating it.</p>}
    {busy && <p className="personal-note" role="status">Saving your movie…</p>}
    {error && <p className="personal-error" role="alert">{error}</p>}
  </section>;
}
