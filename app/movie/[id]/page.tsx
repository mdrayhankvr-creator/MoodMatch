import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { PosterArt } from "@/components/poster-art";
import { AccountNav } from "@/components/account-nav";
import { MoviePersonalControls } from "@/components/movie-personal-controls";
import { getCatalogueMovie } from "@/lib/catalogue.mjs";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";

export async function generateMetadata({ params }: PageProps<"/movie/[id]">): Promise<Metadata> {
  const { id } = await params;
  const movie = getCatalogueMovie(await getCatalogueSnapshot(), id);
  if (!movie) notFound();
  return { title: `${movie.title} | MoodMatch` };
}

export default function MovieDetail({ params }: PageProps<"/movie/[id]">) {
  return <Suspense fallback={<main className="detail-main page-width" role="status">Opening film details…</main>}><DetailContent params={params} /></Suspense>;
}

async function DetailContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const movie = getCatalogueMovie(await getCatalogueSnapshot(), id);
  if (!movie) notFound();
  return <div className="site-shell detail-shell">
    <header className="site-header page-width"><Link href="/" className="brand" aria-label="MoodMatch home"><span className="brand__mark" aria-hidden="true">✳</span><span>Mood<span className="brand__accent">Match</span></span></Link><nav aria-label="Primary navigation"><Link href="/#browse">Browse movies</Link><Link href="/#discover">AI mood search</Link></nav><AccountNav /></header>
    <main className="detail-main page-width"><Link className="detail-back" href="/#browse">← Back to the collection</Link><div className="detail-grid"><div className="detail-poster"><PosterArt title={movie.title} featured artwork={movie.artwork} /></div><div className="detail-copy"><span className="section-kicker">FROM THE VERIFIED MOVIE CATALOGUE</span><h1>{movie.title}</h1><div className="detail-facts"><span>{movie.year ?? "Year unknown"}</span><span>Movie</span><span>{movie.genres.length ? movie.genres.join(" · ") : "Genre not listed"}</span></div><p>Explore this film through its original source article. Plot text is withheld while redistribution rights are reviewed.</p><a className="hero__primary" href={movie.sourceUrl} target="_blank" rel="noopener noreferrer">View source article <span aria-hidden="true">↗</span></a><MoviePersonalControls id={movie.id} /><div className="detail-note"><span>ARTWORK NOTE</span>{movie.artwork ? <p>Artwork by <a href={movie.artwork.filePage} target="_blank" rel="noopener noreferrer">{movie.artwork.creator}</a> · <a href={movie.artwork.licenseUrl} target="_blank" rel="noopener noreferrer">{movie.artwork.license}</a>. See the file page for rights and attribution details.</p> : <p>This is original MoodMatch graphic artwork, not an official film poster. No third-party imagery is displayed without a reviewed license.</p>}</div></div></div></main>
  </div>;
}
