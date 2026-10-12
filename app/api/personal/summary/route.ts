import { verifiedSession } from "@/lib/supabase/server";
import { getCatalogueSnapshot } from "@/lib/catalogue-server.mjs";
import { json } from "@/lib/personal/http.mjs";
import { readSummary } from "@/lib/personal/store";

export async function GET() {
  try {
    const session = await verifiedSession();
    if (!session) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to view personal data." });
    return json(200, await readSummary(session.client, session.userId, await getCatalogueSnapshot()));
  } catch { return json(503, null, { code: "PERSONAL_DATA_UNAVAILABLE", message: "Personal data is temporarily unavailable." }); }
}
