"use client";

import Link from "next/link";
import { useState } from "react";
import { CATALOGUE_GENRES } from "@/lib/catalogue.mjs";
import { usePersonal } from "./personal-provider";

export function ProfileDashboard() {
  const personal = usePersonal();
  const profile = personal.summary?.profile;
  const [draft, setDraft] = useState<{ name: string; avatar: string; genres: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  if (personal.status !== "ready") return <p className="personal-note" role="status">{personal.status === "error" ?
    "Your profile could not be loaded. Please refresh this page." : "Loading your profile…"}</p>;
  const name = draft?.name ?? profile?.displayName ?? "";
  const avatar = draft?.avatar ?? profile?.avatarUrl ?? "";
  const genres = draft?.genres ?? profile?.favoriteGenres ?? [];
  const watched = personal.summary.movies.filter((movie) => movie.watchedAt)
    .sort((a, b) => (b.watchedAt ?? "").localeCompare(a.watchedAt ?? ""));
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setNotice("");
    try {
      const response = await fetch("/api/personal/profile", { method: "PATCH", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ displayName: name, avatarUrl: avatar.trim() || null, favoriteGenres: genres }) });
      if (!response.ok) throw new Error("Invalid profile");
      await personal.refresh(); setDraft(null); setNotice("Profile saved.");
    } catch { setNotice("Profile could not be saved. Check your entries and try again."); }
    finally { setBusy(false); }
  }
  return <div className="personal-page__content">
    <div className="profile-intro"><div className="profile-avatar" aria-hidden="true">{profile?.avatarUrl ?
      // eslint-disable-next-line @next/next/no-img-element
      <img src={profile.avatarUrl} alt="" width="72" height="72" referrerPolicy="no-referrer" /> :
      profile?.displayName.slice(0, 1).toUpperCase()}</div>
      <div><span className="section-kicker">YOUR SPACE</span><h1>{profile?.displayName}</h1><p>Your movie activity stays private to your account.</p></div></div>
    <div className="profile-stats" aria-label="Your viewing statistics"><div><strong>{personal.summary.counts.watched}</strong><span>Watched</span></div>
      <div><strong>{personal.summary.counts.watchlist}</strong><span>Want to watch</span></div>
      <div><strong>{personal.summary.counts.rated}</strong><span>Rated</span></div></div>
    <section className="profile-section" aria-labelledby="profile-edit-title"><h2 id="profile-edit-title">Edit profile</h2>
      <form className="profile-form" onSubmit={(event) => void save(event)}>
        <label htmlFor="profile-name">Display name</label><input id="profile-name" value={name} maxLength={80} required
          onChange={(event) => setDraft({ name: event.target.value, avatar, genres })} />
        <label htmlFor="profile-avatar">Google avatar URL (optional)</label><input id="profile-avatar" type="url" value={avatar}
          maxLength={2048} placeholder="https://…googleusercontent.com/…" onChange={(event) => setDraft({ name, avatar: event.target.value, genres })} />
        <fieldset><legend>Favorite genres</legend><div className="profile-genres">{CATALOGUE_GENRES.map((genre) =>
          <label key={genre}><input type="checkbox" checked={genres.includes(genre)} onChange={(event) => setDraft({ name, avatar,
            genres: event.target.checked ? [...genres, genre] : genres.filter((item) => item !== genre) })} />{genre}</label>)}</div></fieldset>
        <button type="submit" disabled={busy}>{busy ? "Saving…" : "Save profile"}</button>
        {notice && <p role="status">{notice}</p>}
      </form>
    </section>
    <section className="profile-section" aria-labelledby="watched-title"><h2 id="watched-title">Watched history</h2>
      {watched.length ? <ul className="personal-list">{watched.map((movie) => <li key={movie.id}><Link href={`/movie/${movie.id}`}>{movie.title}</Link>
        <span>{movie.watchedAt ? new Date(movie.watchedAt).toLocaleDateString() : ""}{movie.rating !== null ? ` · Your rating ${movie.rating}/10` : ""}</span></li>)}</ul> :
        <p className="personal-empty">No watched films yet. <Link href="/#browse">Explore the collection</Link> and mark one watched.</p>}
    </section>
  </div>;
}
