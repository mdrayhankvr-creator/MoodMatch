import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import { sameOrigin } from "@/lib/personal/http.mjs";

export async function POST(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) return new Response("Account service unavailable.", { status: 503 });
  if (!sameOrigin(request, config.origin)) return new Response("Forbidden.", { status: 403 });
  const client = await createClient();
  if (!client) return new Response("Account service unavailable.", { status: 503 });
  const { error } = await client.auth.signOut({ scope: "local" });
  if (error) return new Response("Sign-out is temporarily unavailable.", { status: 503,
    headers: { "Cache-Control": "private, no-store" } });
  const response = NextResponse.redirect(new URL("/", config.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
