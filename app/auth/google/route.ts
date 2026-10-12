import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/personal/http.mjs";

export async function GET(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) return NextResponse.redirect(new URL("/login?error=setup", request.url));
  const next = safeNextPath(request.nextUrl.searchParams.get("next"));
  const client = await createClient();
  if (!client) return NextResponse.redirect(new URL("/login?error=setup", config.origin));
  const redirectTo = `${config.origin}/auth/callback`;
  const { data, error } = await client.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
  if (error || !data.url) return NextResponse.redirect(new URL("/login?error=oauth", config.origin));
  const response = NextResponse.redirect(data.url);
  response.cookies.set("mm_auth_next", next, { httpOnly: true, sameSite: "lax", path: "/auth",
    secure: config.origin.startsWith("https:"), maxAge: 300 });
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
