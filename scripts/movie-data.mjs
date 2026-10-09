import { createHash } from "node:crypto";
import { Transform } from "node:stream";

export const MOVIE_COLUMNS = ["id", "title", "year", "genre", "plot", "source_url"];
export const MIN_PLOT_CHARACTERS = 120;
export const MIN_PLOT_WORDS = 20;
export const MAX_MOVIES = 1000;

export function normalizeWhitespace(value) {
  return String(value ?? "").normalize("NFC").replace(/\s+/gu, " ").trim();
}

export function validYear(value) {
  return value === "" || (/^\d{4}$/u.test(value) && Number(value) >= 1888 && Number(value) <= 2100);
}

export function validPlot(plot) {
  return [...plot].length >= MIN_PLOT_CHARACTERS && plot.split(/\s+/u).length >= MIN_PLOT_WORDS;
}

export function canonicalSourceUrl(value) {
  try {
    const url = new URL(normalizeWhitespace(value));

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !/^(?:[a-z-]+\.)?wikipedia\.org$/u.test(url.hostname) ||
      !url.pathname.startsWith("/wiki/")
    ) {
      return "";
    }

    return `https://${url.hostname}${url.pathname}`;
  } catch {
    return "";
  }
}

export function sourceArticleKey(value) {
  const canonical = canonicalSourceUrl(value);
  if (!canonical) return "";
  const url = new URL(canonical);
  try {
    const title = decodeURIComponent(url.pathname.slice("/wiki/".length))
      .replaceAll("_", " ")
      .normalize("NFC")
      .replace(/\s+/gu, " ")
      .trim();
    return `${url.hostname.toLowerCase()}/wiki/${title}`;
  } catch {
    return "";
  }
}

export function sourceMovieId(movie) {
  const source = sourceArticleKey(movie.source_url);
  if (!source) throw new Error("Cannot create a movie ID without a valid source article.");
  return `movie_${createHash("sha256").update(`article:\0${source}`).digest("hex").slice(0, 20)}`;
}

export function identityKey(movie) {
  const title = movie.title.normalize("NFKC").toLowerCase();
  return movie.year ? `title-year:${title}\0${movie.year}` : `url:${movie.source_url}`;
}

export function movieId(movie) {
  return `movie_${createHash("sha256").update(identityKey(movie)).digest("hex").slice(0, 20)}`;
}

export function decade(movie) {
  return movie.year ? `${Math.floor(Number(movie.year) / 10) * 10}s` : "unknown";
}

const GENRE_PATTERNS = [
  ["science fiction", /\b(?:sci[ -]?fi|science[ -]?fiction)\b/u],
  ["animation", /\banimat/u],
  ["documentary", /\bdocumentary\b/u],
  ["action", /\baction\b/u],
  ["adventure", /\badventure\b/u],
  ["biography", /\b(?:biograph|biopic)/u],
  ["comedy", /\bcomedy\b/u],
  ["crime", /\bcrime\b/u],
  ["drama", /\bdrama\b/u],
  ["family", /\bfamily\b/u],
  ["fantasy", /\bfantasy\b/u],
  ["historical", /\bhistor/u],
  ["horror", /\bhorror\b/u],
  ["musical", /\bmusical\b/u],
  ["mystery", /\bmystery\b/u],
  ["romance", /\bromanc/u],
  ["sports", /\bsport/u],
  ["thriller", /\bthriller\b/u],
  ["war", /\bwar\b/u],
  ["western", /\bwestern\b/u],
];

export function genreGroup(genre) {
  const first = normalizeWhitespace(genre).toLowerCase().split(/[,/;|]/u)[0];
  if (!first || first === "unknown") return "unknown";
  return GENRE_PATTERNS.find(([, pattern]) => pattern.test(first))?.[0] ?? "other";
}

export function csvField(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function strictUtf8() {
  const decoder = new TextDecoder("utf-8", { fatal: true });

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        callback(null, decoder.decode(chunk, { stream: true }));
      } catch {
        callback(new Error("Input is not valid UTF-8."));
      }
    },
    flush(callback) {
      try {
        callback(null, decoder.decode());
      } catch {
        callback(new Error("Input is not valid UTF-8."));
      }
    },
  });
}
