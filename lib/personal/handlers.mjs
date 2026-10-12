import { getCatalogueMovie } from "../catalogue.mjs";
import { nextMovieStatus, parseProfilePatch, validMovieId } from "./domain.mjs";
import { json, mutationError, readSmallJson, sameOrigin } from "./http.mjs";

/** Dependencies are injected so authorization and write boundaries can be tested offline. */
export async function handleMovieMutation({ request, userId, movieId, catalogue, origin,
  readStatus, writeStatus, now = () => new Date() }) {
  if (!userId) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to save films." });
  if (!sameOrigin(request, origin)) return json(403, null, { code: "BAD_ORIGIN", message: "Request origin is not allowed." });
  if (!validMovieId(movieId) || !getCatalogueMovie(catalogue, movieId)) {
    return json(404, null, { code: "MOVIE_NOT_FOUND", message: "Movie not found." });
  }
  try {
    const patch = await readSmallJson(request);
    const current = await readStatus(userId, movieId);
    const next = nextMovieStatus(current, patch, now());
    const saved = await writeStatus(userId, movieId, next);
    return json(200, { id: movieId, ...saved });
  } catch (error) { return mutationError(error); }
}

export async function handleProfileMutation({ request, userId, origin, writeProfile }) {
  if (!userId) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to edit your profile." });
  if (!sameOrigin(request, origin)) return json(403, null, { code: "BAD_ORIGIN", message: "Request origin is not allowed." });
  try {
    const patch = parseProfilePatch(await readSmallJson(request));
    const profile = await writeProfile(userId, patch);
    return json(200, profile);
  } catch (error) { return mutationError(error); }
}
