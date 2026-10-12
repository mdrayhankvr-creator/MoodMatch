import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { safeNextPath } from "@/lib/personal/http.mjs";
import { userIdFromVerifiedClaims } from "@/lib/personal/domain.mjs";

export async function GET(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) return NextResponse.redirect(new URL("/login?error=setup", request.url));
  const next = safeNextPath(request.cookies.get("mm_auth_next")?.value);
  const code = request.nextUrl.searchParams.get("code");
  if (!code || code.length > 2048) return NextResponse.redirect(new URL("/login?error=oauth", config.origin));
  const client = await createClient();
  if (!client) return NextResponse.redirect(new URL("/login?error=setup", config.origin));
  const { error } = await client.auth.exchangeCodeForSession(code);
  if (error) return NextResponse.redirect(new URL("/login?error=oauth", config.origin));
  if (!userIdFromVerifiedClaims(await client.auth.getClaims())) {
    return NextResponse.redirect(new URL("/login?error=oauth", config.origin));
  }
  const response = NextResponse.redirect(new URL(next, config.origin));
  response.cookies.delete("mm_auth_next");
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
