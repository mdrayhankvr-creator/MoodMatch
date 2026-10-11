import { safeSourceUrl } from "./search-ui.mjs";

export const CATALOGUE_GENRES = Object.freeze([
  "action", "comedy", "crime", "drama", "horror", "mystery",
  "romance", "science fiction", "thriller", "western",
]);
export const MAX_BROWSE_LIMIT = 24;
const MOVIE_ID = /^movie_[a-f0-9]{20,64}$/u;
const APPROVED_ARTWORK = Object.freeze({});
const ALLOWED_LICENSES = Object.freeze({
  "CC BY 4.0": "https://creativecommons.org/licenses/by/4.0/",
  "CC BY-SA 4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
  "CC0 1.0": "https://creativecommons.org/publicdomain/zero/1.0/",
});

/** No file enters this manifest without a separate file-level rights review. */
export function selectApprovedArtwork(id, manifest = APPROVED_ARTWORK) {
  if (!MOVIE_ID.test(id)) return null;
  const item = manifest[id];
  if (!item) return null;
  if (typeof item.path !== "string" ||
      !new RegExp(`^/artwork/${id}\\.(?:webp|avif|png|jpg)$`, "u").test(item.path) ||
      typeof item.creator !== "string" || !item.creator.trim() || item.creator.length > 200 ||
      /[\p{Cc}\p{Cf}]/u.test(item.creator) ||
      !Object.hasOwn(ALLOWED_LICENSES, item.license) ||
      typeof item.filePage !== "string" || !/^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s]+$/u.test(item.filePage)) {
    return null;
  }
  return { path: item.path, creator: item.creator, license: item.license,
    licenseUrl: ALLOWED_LICENSES[item.license], filePage: item.filePage };
}

export function publicCatalogueMovie(row) {
  if (!row || typeof row !== "object" || !MOVIE_ID.test(row.id) ||
      typeof row.title !== "string" || !row.title.trim() || row.title.length > 300 ||
      /[\p{Cc}\u202A-\u202E\u2066-\u2069]/u.test(row.title) ||
      typeof row.genre !== "string" || typeof row.year !== "string") {
    throw new Error("Invalid catalogue movie metadata.");
  }
  const sourceUrl = safeSourceUrl(row.source_url);
  if (!sourceUrl) throw new Error("Invalid catalogue source URL.");
  const year = row.year === "" ? null : Number(row.year);
  if (year !== null && (!Number.isSafeInteger(year) || year < 1800 || year > 2100)) {
    throw new Error("Invalid catalogue release year.");
  }
  return {
    id: row.id, title: row.title, year,
    genres: row.genre.split(",").map((part) => part.trim()).filter(Boolean),
    contentType: "movie", sourceUrl,
    artwork: selectApprovedArtwork(row.id),
  };
}

export function makeCatalogue(rows) {
  if (!Array.isArray(rows)) throw new Error("Catalogue rows are missing.");
  const movies = rows.map(publicCatalogueMovie).sort((a, b) => a.id.localeCompare(b.id, "en"));
  if (new Set(movies.map((movie) => movie.id)).size !== movies.length) {
    throw new Error("Catalogue IDs must be unique.");
  }
  return movies;
}

export function getCatalogueMovie(movies, id) {
  if (!MOVIE_ID.test(id)) return null;
  return movies.find((movie) => movie.id === id) ?? null;
}

export function browseCatalogue(movies, { genre = "", after = "", limit = 12 } = {}) {
  if (!Array.isArray(movies) || (genre && !CATALOGUE_GENRES.includes(genre)) ||
      (after && !MOVIE_ID.test(after)) || !Number.isSafeInteger(limit) ||
      limit < 1 || limit > MAX_BROWSE_LIMIT) {
    throw new Error("Invalid catalogue browse request.");
  }
  const selected = genre ? movies.filter((movie) => movie.genres.includes(genre)) : movies;
  const afterIndex = after ? selected.findIndex((movie) => movie.id === after) : -1;
  if (after && afterIndex < 0) throw new Error("Unknown catalogue cursor.");
  const items = selected.slice(afterIndex + 1, afterIndex + 1 + limit);
  const hasMore = afterIndex + 1 + limit < selected.length;
  return { items, total: selected.length,
    nextCursor: hasMore ? items.at(-1)?.id ?? null : null,
    genre: genre || null };
}
