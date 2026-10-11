import Link from "next/link";
import { PosterArt } from "@/components/poster-art";
import type { ApprovedArtwork } from "@/components/poster-art";
import { safeSourceUrl } from "@/lib/search-ui.mjs";

export type MovieResult = {
  id: string; title: string; year: number | null; genres: string[];
  contentType: "movie"; sourceUrl: string; similarityScore?: number; artwork?: ApprovedArtwork | null;
};

export function MovieCard({ movie, index }: { movie: MovieResult; index: number }) {
  const sourceUrl = safeSourceUrl(movie.sourceUrl);
  return <article className="movie-card">
    <Link href={`/movie/${movie.id}`} className="movie-card__poster-link" aria-label={`View details for ${movie.title}`}><PosterArt title={movie.title} index={index} artwork={movie.artwork} /></Link>
    <div className="movie-card__body">
      <div className="movie-card__eyebrow"><span>FILM · {movie.year ?? "YEAR UNKNOWN"}</span>
        {movie.similarityScore !== undefined && <span aria-label={`Similarity score ${movie.similarityScore.toFixed(2)} out of 1`}>{movie.similarityScore.toFixed(2)} SIMILARITY</span>}</div>
      <h3><Link href={`/movie/${movie.id}`}>{movie.title}</Link></h3>
      <p className="movie-card__genres">{movie.genres.length ? movie.genres.join(" · ") : "Genre not listed"}</p>
      {movie.artwork && <p className="movie-card__credit">Artwork: <a href={movie.artwork.filePage} target="_blank" rel="noopener noreferrer">{movie.artwork.creator}</a> · <a href={movie.artwork.licenseUrl} target="_blank" rel="noopener noreferrer">{movie.artwork.license}</a></p>}
      <div className="movie-card__bottom"><Link href={`/movie/${movie.id}`}>Explore film <span aria-hidden="true">↗</span></Link>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noopener noreferrer" aria-label={`View source for ${movie.title} (opens in a new tab)`}>Source</a>}</div>
    </div>
  </article>;
}
