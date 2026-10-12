import Image from "next/image";

export type ApprovedArtwork = {
  path: string; creator: string; license: string; licenseUrl: string; filePage: string;
};

type PosterArtProps = { title: string; index?: number; featured?: boolean; artwork?: ApprovedArtwork | null };

/** Original CSS artwork until an individual film image passes rights review. */
export function PosterArt({ title, index = 0, featured = false, artwork = null }: PosterArtProps) {
  if (artwork) return <div className="poster-art poster-art--image"><Image src={artwork.path}
    alt={`Artwork for ${title}`} fill sizes={featured ? "(max-width: 760px) 60vw, 390px" : "(max-width: 760px) 50vw, 25vw"}
    priority={featured} /></div>;
  return <div className={`poster-art poster-art--${index % 5}${featured ? " poster-art--featured" : ""}`}
    role="img" aria-label={`Original graphic placeholder for ${title}`}>
    <span className="poster-art__grain" aria-hidden="true" />
    <span className="poster-art__disc" aria-hidden="true" />
    <span className="poster-art__orbit" aria-hidden="true" />
    <span className="poster-art__label" aria-hidden="true">MOODMATCH / FILM</span>
    <span className="poster-art__title" aria-hidden="true">{title}</span>
    <span className="poster-art__foot" aria-hidden="true">A STORY TO DISCOVER <span>✦</span></span>
  </div>;
}
