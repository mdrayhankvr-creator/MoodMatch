import Link from "next/link";
import { Suspense } from "react";
import { authConfigured } from "@/lib/supabase/config";
import { safeNextPath } from "@/lib/personal/http.mjs";

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  return <Suspense fallback={<main className="personal-page page-width">Opening sign-in…</main>}>
    <LoginContent searchParams={searchParams} /></Suspense>;
}

async function LoginContent({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const query = await searchParams;
  const next = safeNextPath(query.next);
  const enabled = authConfigured();
  return <div className="site-shell"><header className="site-header page-width"><Link href="/" className="brand">Mood<span className="brand__accent">Match</span></Link></header>
    <main className="personal-page page-width"><span className="section-kicker">YOUR MOVIE SPACE</span><h1>Keep the films that stay with you.</h1>
      <p>Sign in to save a watchlist, record what you have watched, and rate your own films.</p>
      {enabled ? <a className="hero__primary" href={`/auth/google?next=${encodeURIComponent(next)}`}>Continue with Google ↗</a> :
        <p className="personal-error" role="status">Google sign-in is not configured yet. Set up Supabase to use personal features.</p>}
      {query.error && <p className="personal-error" role="alert">Sign-in could not be completed. Please try again.</p>}
      <p><Link href="/">Return to movie discovery</Link></p>
    </main></div>;
}
