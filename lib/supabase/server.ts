import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseConfig } from "./config";
import { userIdFromVerifiedClaims } from "../personal/domain.mjs";

export async function createClient() {
  const config = getSupabaseConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.key, {
    cookieOptions: { path: "/", sameSite: "lax", httpOnly: true,
      secure: config.origin.startsWith("https:") },
    cookies: {
      getAll: () => store.getAll(),
      setAll: (items) => {
        try { items.forEach(({ name, value, options }) => store.set(name, value, options)); }
        catch { /* Server Components are read-only; Proxy refreshes sessions. */ }
      },
    },
  });
}

export async function verifiedSession() {
  const client = await createClient();
  if (!client) return null;
  const id = userIdFromVerifiedClaims(await client.auth.getClaims());
  if (!id) return null;
  return { client, userId: id };
}
