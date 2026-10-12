import { CATALOGUE_GENRES } from "../catalogue.mjs";

export const MOVIE_ID = /^movie_[a-f0-9]{20,64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function validUserId(id) { return typeof id === "string" && UUID.test(id); }
export function validMovieId(id) { return typeof id === "string" && MOVIE_ID.test(id); }

export function userIdFromVerifiedClaims(result) {
  if (result?.error) return null;
  const id = result?.data?.claims?.sub;
  return validUserId(id) ? id : null;
}

export function ownsRow(userId, row) {
  if (!validUserId(userId) || !row || typeof row !== "object") return false;
  if (Object.hasOwn(row, "user_id")) return row.user_id === userId;
  return row.id === userId;
}

export function parseProfilePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_PROFILE");
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !["displayName", "avatarUrl", "favoriteGenres"].includes(key))) {
    throw new Error("INVALID_PROFILE");
  }
  const patch = {};
  if (Object.hasOwn(value, "displayName")) {
    if (typeof value.displayName !== "string") throw new Error("INVALID_PROFILE");
    const name = value.displayName.normalize("NFC").trim();
    if (name.length < 1 || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new Error("INVALID_PROFILE");
    patch.display_name = name;
  }
  if (Object.hasOwn(value, "avatarUrl")) {
    if (value.avatarUrl !== null && safeGoogleAvatar(value.avatarUrl) === null) throw new Error("INVALID_PROFILE");
    patch.avatar_url = value.avatarUrl === null ? null : safeGoogleAvatar(value.avatarUrl);
  }
  if (Object.hasOwn(value, "favoriteGenres")) {
    if (!Array.isArray(value.favoriteGenres) || value.favoriteGenres.length > CATALOGUE_GENRES.length ||
        value.favoriteGenres.some((genre) => typeof genre !== "string" || !CATALOGUE_GENRES.includes(genre)) ||
        new Set(value.favoriteGenres).size !== value.favoriteGenres.length) throw new Error("INVALID_PROFILE");
    patch.preferences = { favoriteGenres: value.favoriteGenres };
  }
  return patch;
}

export function safeGoogleAvatar(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port ||
        !/(^|\.)googleusercontent\.com$/u.test(url.hostname)) return null;
    return url.href;
  } catch { return null; }
}

export function parseMoviePatch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_MOVIE_STATUS");
  const keys = Object.keys(value);
  if (!keys.length || keys.some((key) => !["watched", "watchlisted", "rating"].includes(key))) {
    throw new Error("INVALID_MOVIE_STATUS");
  }
  if (Object.hasOwn(value, "watched") && typeof value.watched !== "boolean") throw new Error("INVALID_MOVIE_STATUS");
  if (Object.hasOwn(value, "watchlisted") && typeof value.watchlisted !== "boolean") throw new Error("INVALID_MOVIE_STATUS");
  if (Object.hasOwn(value, "rating") && value.rating !== null &&
      (!Number.isInteger(value.rating) || value.rating < 1 || value.rating > 10)) throw new Error("INVALID_RATING");
  return value;
}

export function nextMovieStatus(current, patch, now) {
  const change = parseMoviePatch(patch);
  const timestamp = new Date(now);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("INVALID_TIME");
  const watchedAt = change.watched === false ? null :
    change.watched === true ? current?.watched_at ?? timestamp.toISOString() : current?.watched_at ?? null;
  const watchlistedAt = change.watchlisted === false ? null :
    change.watchlisted === true ? current?.watchlisted_at ?? timestamp.toISOString() : current?.watchlisted_at ?? null;
  const rating = !watchedAt ? null : Object.hasOwn(change, "rating") ? change.rating : current?.rating ?? null;
  if (change.rating !== undefined && change.rating !== null && !watchedAt) throw new Error("RATING_REQUIRES_WATCHED");
  return { watched_at: watchedAt, watchlisted_at: watchlistedAt, rating };
}

export function publicStatus(row) {
  if (!row) return { watchedAt: null, watchlistedAt: null, rating: null };
  return { watchedAt: row.watched_at ?? null, watchlistedAt: row.watchlisted_at ?? null,
    rating: row.rating ?? null };
}
