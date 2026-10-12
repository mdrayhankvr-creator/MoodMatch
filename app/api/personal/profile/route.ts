import { type NextRequest } from "next/server";
import { verifiedSession } from "@/lib/supabase/server";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { handleProfileMutation } from "@/lib/personal/handlers.mjs";
import { json } from "@/lib/personal/http.mjs";
import { writeProfile } from "@/lib/personal/store";

export async function PATCH(request: NextRequest) {
  try {
    const config = getSupabaseConfig();
    if (!config) return json(503, null, { code: "ACCOUNT_UNAVAILABLE", message: "Account setup is incomplete." });
    const session = await verifiedSession();
    if (!session) return json(401, null, { code: "AUTH_REQUIRED", message: "Sign in to edit your profile." });
    return handleProfileMutation({ request, userId: session.userId, origin: config.origin,
      writeProfile: (userId: string, patch: Record<string, unknown>) => writeProfile(session.client, userId, patch) });
  } catch { return json(503, null, { code: "PERSONAL_DATA_UNAVAILABLE", message: "Personal data is temporarily unavailable." }); }
}
