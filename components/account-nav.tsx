"use client";

import Link from "next/link";
import { usePersonal } from "./personal-provider";

export function AccountNav() {
  const personal = usePersonal();
  if (personal.status === "unavailable") return <span className="account-unavailable" title="Supabase setup is required">Accounts unavailable</span>;
  if (personal.status === "loading") return <span className="account-unavailable" role="status">Loading account…</span>;
  if (personal.status === "error") return <button className="account-link" type="button" onClick={() => void personal.refresh()}>Retry account</button>;
  if (personal.status === "guest") return <Link className="account-link" href="/login">Sign in with Google</Link>;
  if (!personal.summary) return null;
  return <details className="account-menu"><summary aria-label="Open profile menu">
    {/* The Google-hosted 25px avatar is displayed directly after strict URL validation. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    {personal.summary.profile.avatarUrl && <img src={personal.summary.profile.avatarUrl} alt="" width="25" height="25" referrerPolicy="no-referrer" />}
    <span>{personal.summary.profile.displayName}</span></summary>
    <div className="account-menu__panel"><Link href="/profile">My profile</Link><Link href="/watchlist">Watchlist</Link>
      <form action="/auth/signout" method="post"><button type="submit">Sign out</button></form></div></details>;
}
