import { type NextRequest } from "next/server";
import { verifiedSession } from "@/lib/supabase/server";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";
import { getCatalogueMovie } from "@/lib/catalogue.mjs";
import { validMovieId, publicStatus } from "@/lib/personal/domain.mjs";
import { handleMovieMutation } from "@/lib/personal/handlers.mjs";
import { json } from "@/lib/personal/http.mjs";
import { readStatus, writeStatus } from "@/lib/personal/store";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await verifiedSession();
    if (!session) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to view personal data." });
    const { id } = await params;
    if (!validMovieId(id) || !getCatalogueMovie(await getCatalogueSnapshot(), id)) {
      return json(404, null, { code: "MOVIE_NOT_FOUND", message: "Movie not found." });
    }
    return json(200, { id, ...publicStatus(await readStatus(session.client, session.userId, id)) });
  } catch { return json(503, null, { code: "PERSONAL_DATA_UNAVAILABLE", message: "Personal data is temporarily unavailable." }); }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const config = getSupabaseConfig();
    if (!config) return json(503, null, { code: "ACCOUNT_UNAVAILABLE", message: "Account setup is incomplete." });
    const session = await verifiedSession();
    if (!session) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to save films." });
    const { id } = await params;
    return handleMovieMutation({ request, userId: session.userId, movieId: id,
      catalogue: await getCatalogueSnapshot(), origin: config.origin,
      readStatus: (userId: string, movieId: string) => readStatus(session.client, userId, movieId),
      writeStatus: (userId: string, movieId: string, next: { watched_at: string | null;
        watchlisted_at: string | null; rating: number | null }) => writeStatus(session.client, userId, movieId, next) });
  } catch { return json(503, null, { code: "PERSONAL_DATA_UNAVAILABLE", message: "Personal data is temporarily unavailable." }); }
}
