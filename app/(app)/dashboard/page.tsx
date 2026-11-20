/**
 * /dashboard
 *
 * Server Component. Its only jobs are to prove who is asking and to hand that
 * identity to the client view:
 *
 *   1. Read the `__Host-session` cookie.
 *   2. Verify it against the `sessions` table (hash lookup, expiry check).
 *   3. With no valid session, show the "Steam Account Required" card
 *      (v1.13; before, it redirected to the landing page).
 *   4. Otherwise render <DashboardView user={...} />.
 *
 * Only `steamid`, display name and avatar URL cross to the client. The
 * session token never does.
 *
 * Requires Next.js 15.1 or later (`after`, async `cookies`).
 */
import type { Metadata } from "next";

import { DashboardView } from "@/components/dashboard-view";
import { SignInRequired } from "@/components/sign-in-required";
import { getCurrentUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Dashboard · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  // Name and avatar are filled in (once) by getCurrentUser, shared with the navigation.
  const user = await getCurrentUser();
  if (!user) return <SignInRequired returnTo="/dashboard" title="Dashboard" />;
  return <DashboardView user={user} />;
}
