import Link from "next/link";
import { PosterArt } from "@/components/poster-art";
import type { ApprovedArtwork } from "@/components/poster-art";
import { safeSourceUrl } from "@/lib/search-ui.mjs";
import { usePersonal } from "@/components/personal-provider";

export type MovieResult = {
  id: string; title: string; year: number | null; genres: string[];
  contentType: "movie"; sourceUrl: string; similarityScore?: number; artwork?: ApprovedArtwork | null;
};

export function MovieCard({ movie, index }: { movie: MovieResult; index: number }) {
  const sourceUrl = safeSourceUrl(movie.sourceUrl);
  const personal = usePersonal();
  const saved = personal.summary?.movies.find((item) => item.id === movie.id);
  return <article className="movie-card">
    <Link href={`/movie/${movie.id}`} className="movie-card__poster-link" aria-label={`View details for ${movie.title}`}><PosterArt title={movie.title} index={index} artwork={movie.artwork} /></Link>
    <div className="movie-card__body">
      <div className="movie-card__eyebrow"><span>FILM · {movie.year ?? "YEAR UNKNOWN"}</span>
        {movie.similarityScore !== undefined && <span aria-label={`Similarity score ${movie.similarityScore.toFixed(2)} out of 1`}>{movie.similarityScore.toFixed(2)} SIMILARITY</span>}</div>
      <h3><Link href={`/movie/${movie.id}`}>{movie.title}</Link></h3>
      <p className="movie-card__genres">{movie.genres.length ? movie.genres.join(" · ") : "Genre not listed"}</p>
      {saved?.rating !== null && saved?.rating !== undefined && <p className="movie-card__personal">Your rating: {saved.rating}/10</p>}
      {saved?.watchedAt && <p className="movie-card__personal">Watched</p>}
      {saved?.watchlistedAt && <p className="movie-card__personal">Want to watch</p>}
      {movie.artwork && <p className="movie-card__credit">Artwork: <a href={movie.artwork.filePage} target="_blank" rel="noopener noreferrer">{movie.artwork.creator}</a> · <a href={movie.artwork.licenseUrl} target="_blank" rel="noopener noreferrer">{movie.artwork.license}</a></p>}
      <div className="movie-card__bottom"><Link href={`/movie/${movie.id}`}>Explore film <span aria-hidden="true">↗</span></Link>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`View source for ${movie.title} (opens in a new tab)`}>Source</a>}</div>
    </div>
  </article>;
}
