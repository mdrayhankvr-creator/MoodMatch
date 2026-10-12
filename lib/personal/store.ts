import type { SupabaseClient } from "@supabase/supabase-js";
import { ownsRow, publicStatus, safeGoogleAvatar } from "./domain.mjs";

export type PersonalStatus = { watchedAt: string | null; watchlistedAt: string | null; rating: number | null };
export type PersonalMovie = PersonalStatus & { id: string; title: string; year: number | null;
  genres: string[]; sourceUrl: string; contentType: "movie" };
export type PersonalProfile = { displayName: string; avatarUrl: string | null; favoriteGenres: string[] };
export type PersonalSummary = { profile: PersonalProfile; movies: PersonalMovie[];
  counts: { watched: number; watchlist: number; rated: number } };

type StatusRow = { user_id: string; content_type: string; content_id: string;
  watched_at: string | null; watchlisted_at: string | null; rating: number | null };
type ProfileRow = { id: string; display_name: string; avatar_url: string | null;
  preferences: { favoriteGenres?: string[] } | null };

export class PersonalStoreError extends Error {
  constructor() { super("Personal data is temporarily unavailable."); this.name = "PersonalStoreError"; }
}

export async function readProfile(client: SupabaseClient, userId: string): Promise<PersonalProfile> {
  const { data, error } = await client.from("profiles")
    .select("id,display_name,avatar_url,preferences").eq("id", userId).maybeSingle();
  if (error || !data || !ownsRow(userId, data)) throw new PersonalStoreError();
  const row = data as ProfileRow;
  return { displayName: row.display_name, avatarUrl: safeGoogleAvatar(row.avatar_url),
    favoriteGenres: Array.isArray(row.preferences?.favoriteGenres) ? row.preferences.favoriteGenres : [] };
}

export async function readStatus(client: SupabaseClient, userId: string, movieId: string): Promise<StatusRow | null> {
  const { data, error } = await client.from("user_movie_status")
    .select("user_id,content_type,content_id,watched_at,watchlisted_at,rating")
    .eq("user_id", userId).eq("content_type", "movie").eq("content_id", movieId).maybeSingle();
  if (error || (data && (!ownsRow(userId, data) || data.content_id !== movieId || data.content_type !== "movie"))) {
    throw new PersonalStoreError();
  }
  return data as StatusRow | null;
}

export async function writeStatus(client: SupabaseClient, userId: string, movieId: string,
  next: { watched_at: string | null; watchlisted_at: string | null; rating: number | null }): Promise<PersonalStatus> {
  const { data, error } = await client.from("user_movie_status").upsert({
    user_id: userId, content_type: "movie", content_id: movieId, ...next,
  }, { onConflict: "user_id,content_type,content_id" })
    .select("user_id,content_type,content_id,watched_at,watchlisted_at,rating").single();
  if (error || !data || !ownsRow(userId, data) || data.content_id !== movieId || data.content_type !== "movie") {
    throw new PersonalStoreError();
  }
  return publicStatus(data);
}

export async function writeProfile(client: SupabaseClient, userId: string,
  patch: Record<string, unknown>): Promise<PersonalProfile> {
  const { data, error } = await client.from("profiles").update(patch).eq("id", userId)
    .select("id,display_name,avatar_url,preferences").single();
  if (error || !data || !ownsRow(userId, data)) throw new PersonalStoreError();
  const row = data as ProfileRow;
  return { displayName: row.display_name, avatarUrl: safeGoogleAvatar(row.avatar_url),
    favoriteGenres: Array.isArray(row.preferences?.favoriteGenres) ? row.preferences.favoriteGenres : [] };
}

export async function readSummary(client: SupabaseClient, userId: string,
  catalogue: Array<{ id: string; title: string; year: number | null; genres: string[];
    sourceUrl: string; contentType: "movie" }>): Promise<PersonalSummary> {
  const profile = await readProfile(client, userId);
  const rows: StatusRow[] = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    const { data, error } = await client.from("user_movie_status")
      .select("user_id,content_type,content_id,watched_at,watchlisted_at,rating")
      .eq("user_id", userId).eq("content_type", "movie")
      .order("content_id", { ascending: true }).range(offset, offset + 999);
    if (error || !Array.isArray(data) || data.some((row) => !ownsRow(userId, row) || row.content_type !== "movie")) {
      throw new PersonalStoreError();
    }
    rows.push(...data as StatusRow[]);
    if (data.length < 1000) break;
    if (offset === 19000) throw new PersonalStoreError();
  }
  const byId = new Map(catalogue.map((movie) => [movie.id, movie]));
  const movies: PersonalMovie[] = rows.flatMap((row) => {
    const movie = byId.get(row.content_id);
    return movie ? [{ id: movie.id, title: movie.title, year: movie.year, genres: movie.genres,
      sourceUrl: movie.sourceUrl, contentType: "movie" as const, ...publicStatus(row) }] : [];
  });
  return { profile, movies, counts: {
    watched: movies.filter((item) => item.watchedAt).length,
    watchlist: movies.filter((item) => item.watchlistedAt).length,
    rated: movies.filter((item) => item.rating !== null).length,
  } };
}
