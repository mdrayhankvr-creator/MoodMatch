import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { ProfileDashboard } from "@/components/profile-dashboard";
import { AccountNav } from "@/components/account-nav";
import { verifiedSession } from "@/lib/supabase/server";

export default function ProfilePage() {
  return <Suspense fallback={<main className="personal-page page-width" role="status">Opening your profile…</main>}>
    <ProtectedProfile /></Suspense>;
}

async function ProtectedProfile() {
  if (!await verifiedSession()) redirect("/login?next=%2Fprofile");
  return <div className="site-shell"><header className="site-header page-width"><Link href="/" className="brand">Mood<span className="brand__accent">Match</span></Link>
    <nav aria-label="Primary navigation"><Link href="/#browse">Browse movies</Link><Link href="/watchlist">Watchlist</Link></nav><AccountNav /></header>
    <main className="personal-page page-width"><ProfileDashboard /></main></div>;
}
