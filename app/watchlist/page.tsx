import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { WatchlistDashboard } from "@/components/watchlist-dashboard";
import { AccountNav } from "@/components/account-nav";
import { verifiedSession } from "@/lib/supabase/server";

export default function WatchlistPage() {
  return <Suspense fallback={<main className="personal-page page-width" role="status">Opening your watchlist…</main>}>
    <ProtectedWatchlist /></Suspense>;
}

async function ProtectedWatchlist() {
  if (!await verifiedSession()) redirect("/login?next=%2Fwatchlist");
  return <div className="site-shell"><header className="site-header page-width"><Link href="/" className="brand">Mood<span className="brand__accent">Match</span></Link>
    <nav aria-label="Primary navigation"><Link href="/#browse">Browse movies</Link><Link href="/profile">Profile</Link></nav><AccountNav /></header>
    <main className="personal-page page-width"><WatchlistDashboard /></main></div>;
}
