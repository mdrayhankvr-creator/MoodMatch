import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseConfig } from "./config";

export async function updateSession(request: NextRequest) {
  const config = getSupabaseConfig();
  if (!config) {
    const unavailable = NextResponse.next({ request });
    unavailable.headers.set("Cache-Control", "private, no-store");
    return unavailable;
  }
  let response = NextResponse.next({ request });
  response.headers.set("Cache-Control", "private, no-store");
  const client = createServerClient(config.url, config.key, {
    cookieOptions: { path: "/", sameSite: "lax", httpOnly: true,
      secure: config.origin.startsWith("https:") },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (items, cacheHeaders) => {
        items.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        items.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        for (const [name, value] of Object.entries(cacheHeaders ?? {})) response.headers.set(name, value);
        response.headers.set("Cache-Control", "private, no-store");
      },
    },
  });
  await client.auth.getClaims();
  return response;
}
