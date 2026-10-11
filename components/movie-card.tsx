import { safeSourceUrl } from "@/lib/search-ui.mjs";

export type MovieResult = {
  id: string;
  title: string;
  year: number | null;
  genres: string[];
  contentType: "movie";
  sourceUrl: string;
  similarityScore: number;
};

export function MovieCard({ movie, index }: { movie: MovieResult; index: number }) {
  const sourceUrl = safeSourceUrl(movie.sourceUrl);
  const number = String(index + 1).padStart(2, "0");

  return (
    <article className="movie-card">
      <div className={`movie-cover movie-cover--${index % 4}`} aria-hidden="true">
        <div className="movie-cover__top"><span>MOODMATCH / FILM</span><span>{number}</span></div>
        <div className="movie-cover__orbit" />
        <div className="movie-cover__title">{movie.title}</div>
        <span className="movie-cover__bottom">A STORY FOR THIS MOMENT</span>
      </div>
      <div className="movie-card__body">
        <div className="movie-card__eyebrow">
          <span>#{number} RESULT</span>
          <span>{movie.year ?? "Year unknown"}</span>
        </div>
        <h3>{movie.title}</h3>
        <p className="movie-card__genres">{movie.genres.length ? movie.genres.join(" · ") : "Genre not listed"}</p>
        <div className="movie-card__bottom">
          <span className="movie-score" aria-label={`Similarity score ${movie.similarityScore.toFixed(2)} out of 1`}>
            <span className="movie-score__spark" aria-hidden="true">✦</span>
            {movie.similarityScore.toFixed(2)} <span>similarity</span>
          </span>
          {sourceUrl && (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer"
              aria-label={`View source for ${movie.title} (opens in a new tab)`}>
              Source <span aria-hidden="true">↗</span>
            </a>
          )}
        </div>
      </div>
    </article>
  );
}
