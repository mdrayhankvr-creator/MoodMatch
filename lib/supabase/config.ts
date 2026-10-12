export type SupabaseConfig = { url: string; key: string; origin: string };

/** The key is publishable. Never accept or expose a service-role key here. */
export function getSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const origin = process.env.APP_ORIGIN;
  if (!url || !key || !origin || key.startsWith("sb_secret_") || key.startsWith("eyJ")) return null;
  try {
    const project = new URL(url);
    const site = new URL(origin);
    const local = process.env.NODE_ENV !== "production" && site.hostname === "localhost";
    if (project.protocol !== "https:" || project.username || project.password || project.pathname !== "/" ||
        site.username || site.password || site.search || site.hash || site.pathname !== "/" ||
        (site.protocol !== "https:" && !(local && site.protocol === "http:"))) return null;
    return { url: project.origin, key, origin: site.origin };
  } catch { return null; }
}

export function authConfigured() { return getSupabaseConfig() !== null; }
