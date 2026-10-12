import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServerClient } from "@supabase/ssr";
import { makeCatalogue } from "../lib/catalogue.mjs";
import { ownsRow, parseMoviePatch, parseProfilePatch, nextMovieStatus,
  safeGoogleAvatar, userIdFromVerifiedClaims, validMovieId } from "../lib/personal/domain.mjs";
import { handleMovieMutation, handleProfileMutation } from "../lib/personal/handlers.mjs";
import { readSmallJson, safeNextPath } from "../lib/personal/http.mjs";

const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const id = `movie_${"a".repeat(20)}`;
const otherId = `movie_${"b".repeat(20)}`;
const origin = "https://moodmatch.example";
const catalogue = makeCatalogue([{ id, title: "A Real Film", year: "2013", genre: "drama",
  source_url: "https://en.wikipedia.org/wiki/A_Real_Film" }]);
function request(body, requestOrigin = origin) {
  return new Request(`${origin}/api/personal/movies/${id}`, { method: "PUT",
    headers: { "Content-Type": "application/json", Origin: requestOrigin }, body: JSON.stringify(body) });
}
function store() {
  let current = null;
  let writes = 0;
  return { readStatus: async () => current, writeStatus: async (_user, _id, next) => {
    writes += 1;
    current = { user_id: userId, content_type: "movie", content_id: id, ...next };
    return { watchedAt: next.watched_at, watchlistedAt: next.watchlisted_at, rating: next.rating };
  }, get current() { return current; }, get writes() { return writes; } };
}

test("unauthenticated and cross-origin mutations cannot reach storage", async () => {
  const db = store();
  const unauth = await handleMovieMutation({ request: request({ watched: true }), userId: null,
    movieId: id, catalogue, origin, ...db });
  assert.equal(unauth.status, 401);
  const crossOrigin = await handleMovieMutation({ request: request({ watched: true }, "https://evil.example"),
    userId, movieId: id, catalogue, origin, ...db });
  assert.equal(crossOrigin.status, 403);
  assert.equal(db.writes, 0);
  assert.equal(ownsRow(userId, { user_id: otherUserId }), false);
  assert.equal(ownsRow(userId, { user_id: userId }), true);
  assert.equal(ownsRow(userId, { id: otherUserId }), false);
  assert.equal(ownsRow(userId, { user_id: otherUserId, id: userId }), false);
});

test("only verified, well-formed session claims provide an owner ID", () => {
  assert.equal(userIdFromVerifiedClaims({ data: { claims: { sub: userId } }, error: null }), userId);
  assert.equal(userIdFromVerifiedClaims({ data: { claims: { sub: userId } }, error: new Error("bad token") }), null);
  assert.equal(userIdFromVerifiedClaims({ data: { claims: { sub: "not-a-user" } }, error: null }), null);
  assert.equal(userIdFromVerifiedClaims(null), null);
});

test("only exact existing catalogue movie IDs can be saved", async () => {
  const db = store();
  for (const movieId of ["bad", otherId]) {
    const result = await handleMovieMutation({ request: request({ watched: true }), userId,
      movieId, catalogue, origin, ...db });
    assert.equal(result.status, 404);
  }
  assert.equal(validMovieId(id), true);
  assert.equal(db.writes, 0);
});

test("watched and watchlist actions are idempotent and rating requires watched", async () => {
  const db = store();
  const invoke = async (body) => handleMovieMutation({ request: request(body), userId, movieId: id,
    catalogue, origin, ...db, now: () => "2026-10-12T09:00:00.000Z" });
  assert.equal((await invoke({ watched: true })).status, 200);
  assert.equal(db.current.watched_at, "2026-10-12T09:00:00.000Z");
  assert.equal((await invoke({ watched: true })).status, 200);
  assert.equal(db.current.watched_at, "2026-10-12T09:00:00.000Z");
  assert.equal((await invoke({ watchlisted: true })).status, 200);
  assert.equal((await invoke({ watchlisted: true })).status, 200);
  assert.equal((await invoke({ rating: 8 })).status, 200);
  assert.equal(db.current.rating, 8);
  assert.equal((await invoke({ watchlisted: false })).status, 200);
  assert.equal(db.current.watchlisted_at, null);
  assert.equal((await invoke({ rating: null })).status, 200);
  assert.equal(db.current.rating, null);
  assert.equal((await invoke({ rating: 7 })).status, 200);
  assert.equal((await invoke({ watched: false })).status, 200);
  assert.equal(db.current.watched_at, null);
  assert.equal(db.current.rating, null);
  assert.equal((await invoke({ rating: 6 })).status, 400);
});

test("rating and payload validation reject invalid values and client user IDs", async () => {
  for (const rating of [0, 11, 1.5, "8", -1, Number.NaN]) {
    assert.throws(() => parseMoviePatch({ rating }), /INVALID_RATING/u);
  }
  assert.throws(() => parseMoviePatch({ user_id: otherUserId, watched: true }), /INVALID_MOVIE_STATUS/u);
  assert.throws(() => nextMovieStatus(null, { rating: 5 }, Date.now()), /RATING_REQUIRES_WATCHED/u);
  const db = store();
  const result = await handleMovieMutation({ request: request({ user_id: otherUserId, watched: true }),
    userId, movieId: id, catalogue, origin, ...db });
  assert.equal(result.status, 400);
  assert.equal(db.writes, 0);
});

test("profile updates are bounded and reject unsafe avatars or cross-user IDs", async () => {
  assert.deepEqual(parseProfilePatch({ displayName: "  Movie fan  ", favoriteGenres: ["drama"] }),
    { display_name: "Movie fan", preferences: { favoriteGenres: ["drama"] } });
  assert.equal(safeGoogleAvatar("https://lh3.googleusercontent.com/a/photo"),
    "https://lh3.googleusercontent.com/a/photo");
  for (const avatarUrl of ["javascript:alert(1)", "https://evil.example/avatar.png",
    "https://googleusercontent.com.evil.example/avatar.png"]) {
    assert.throws(() => parseProfilePatch({ avatarUrl }), /INVALID_PROFILE/u);
  }
  assert.throws(() => parseProfilePatch({ user_id: otherUserId }), /INVALID_PROFILE/u);
  let saved = null;
  const response = await handleProfileMutation({ request: request({ displayName: "Alex" }), userId,
    origin, writeProfile: async (owner, patch) => { saved = { owner, patch }; return { displayName: "Alex" }; } });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, { owner: userId, patch: { display_name: "Alex" } });
});

test("request size, media type, invalid JSON and storage errors are sanitized", async () => {
  const unsupported = new Request(origin, { method: "PUT", body: "hello" });
  await assert.rejects(() => readSmallJson(unsupported), /UNSUPPORTED_MEDIA_TYPE/u);
  const tooLarge = new Request(origin, { method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(5000) }) });
  await assert.rejects(() => readSmallJson(tooLarge), /BODY_TOO_LARGE/u);
  const invalid = new Request(origin, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{" });
  await assert.rejects(() => readSmallJson(invalid), /INVALID_JSON/u);
  const db = store();
  const result = await handleMovieMutation({ request: request({ watched: true }), userId, movieId: id,
    catalogue, origin, readStatus: db.readStatus, writeStatus: async () => {
      throw new Error("database secret connection string");
    } });
  assert.equal(result.status, 503);
  assert.doesNotMatch(await result.text(), /secret|connection string/u);
});

test("OAuth return paths reject open redirects", () => {
  assert.equal(safeNextPath("/watchlist"), "/watchlist");
  assert.equal(safeNextPath(`/movie/${id}`), `/movie/${id}`);
  for (const value of ["//evil.example", "https://evil.example", "/\\evil", "/api/personal/summary", "/profile?bad=1"]) {
    assert.equal(safeNextPath(value), "/profile");
  }
});

test("Supabase SSR Google flow stores an HttpOnly, Secure PKCE verifier offline", async () => {
  let written = [];
  const client = createServerClient("https://example.supabase.co", "sb_publishable_test", {
    cookieOptions: { path: "/", sameSite: "lax", httpOnly: true, secure: true },
    cookies: { getAll: () => [], setAll: (items) => { written = items; } },
  });
  const { data, error } = await client.auth.signInWithOAuth({ provider: "google",
    options: { redirectTo: `${origin}/auth/callback` } });
  assert.equal(error, null);
  assert.equal(data.url.startsWith("https://example.supabase.co/auth/v1/authorize?"), true);
  assert.equal(written.length, 1);
  assert.equal(written[0].options.httpOnly, true);
  assert.equal(written[0].options.secure, true);
});

test("migration requires owner-scoped RLS for every personal table and command", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261012_personal_movie_profile.sql", import.meta.url), "utf8");
  for (const table of ["profiles", "user_movie_status"]) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "u"));
    for (const operation of ["select", "insert", "update", "delete"]) {
      assert.match(sql, new RegExp(`create policy [^\\n]+ on public\\.${table} for ${operation} to authenticated`, "u"));
    }
  }
  assert.match(sql, /with check \(\(select auth\.uid\(\)\) = user_id\)/u);
  assert.match(sql, /with check \(\(select auth\.uid\(\)\) = id\)/u);
  assert.match(sql, /primary key \(user_id, content_type, content_id\)/u);
  assert.match(sql, /rating between 1 and 10 and watched_at is not null/u);
});
