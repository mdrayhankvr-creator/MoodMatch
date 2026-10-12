import { browseCatalogue, getCatalogueMovie } from "./catalogue.mjs";

const HEADERS = Object.freeze({
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
});

function response(status, data, error = null) {
  return Response.json({ success: status === 200, data, error }, { status, headers: HEADERS });
}

export function createBrowseHandler(loadCatalogue) {
  return async function GET(request) {
    try {
      const url = new URL(request.url);
      if ([...url.searchParams.keys()].some((key) => !["genre", "after", "limit"].includes(key)) ||
          ["genre", "after", "limit"].some((key) => url.searchParams.getAll(key).length > 1)) {
        return response(400, null, { code: "INVALID_BROWSE", message: "Unsupported browse parameters." });
      }
      const rawLimit = url.searchParams.get("limit") ?? "12";
      if (!/^(?:[1-9]|1\d|2[0-4])$/u.test(rawLimit)) {
        return response(400, null, { code: "INVALID_BROWSE", message: "Limit must be 1 to 24." });
      }
      const movies = await loadCatalogue();
      return response(200, browseCatalogue(movies, {
        genre: url.searchParams.get("genre") ?? "",
        after: url.searchParams.get("after") ?? "",
        limit: Number(rawLimit),
      }));
    } catch (error) {
      if (error?.message === "Invalid catalogue browse request." || error?.message === "Unknown catalogue cursor.") {
        return response(400, null, { code: "INVALID_BROWSE", message: "Choose a listed genre or a valid catalogue cursor." });
      }
      return response(503, null, { code: "CATALOGUE_UNAVAILABLE", message: "The catalogue is temporarily unavailable." });
    }
  };
}

export function createDetailHandler(loadCatalogue) {
  return async function GET(_request, { params }) {
    try {
      const { id } = await params;
      const movies = await loadCatalogue();
      const movie = getCatalogueMovie(movies, id);
      if (!movie) return response(404, null, { code: "MOVIE_NOT_FOUND", message: "Movie not found." });
      return response(200, movie);
    } catch {
      return response(503, null, { code: "CATALOGUE_UNAVAILABLE", message: "The catalogue is temporarily unavailable." });
    }
  };
}
