/**
 * /dashboard
 *
 * Server Component. Its only jobs are to prove who is asking and to hand that
 * identity to the client view:
 *
 *   1. Read the `__Host-session` cookie.
 *   2. Verify it against the `sessions` table (hash lookup, expiry check).
 *   3. Redirect to the landing page if there is no valid session.
 *   4. Render <DashboardView user={...} />.
 *
 * Only `steamid`, display name and avatar URL cross to the client. The
 * session token never does.
 *
 * Requires Next.js 15.1 or later (`after`, async `cookies`).
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { after } from "next/server";

import { DashboardView } from "@/components/dashboard-view";
import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE, SIGNED_OUT_PATH } from "@/lib/auth/shared";
import { getPlayerSummary } from "@/lib/steam/endpoints";

export const metadata: Metadata = { title: "Dashboard · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const cookieStore = await cookies();
  const session = await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);

  if (!session) {
    redirect(SIGNED_OUT_PATH);
  }

  return <DashboardView user={await withProfile(session)} />;
}

/**
 * The sign-in callback stores only the SteamID, so a brand-new user has no
 * name or avatar yet. On that first visit, fetch the summary once (which also
 * fills the `users` row). Returning users skip this entirely, so the page
 * normally renders without waiting on Steam. Any failure falls back to the
 * bare session: a missing avatar must not block the dashboard.
 */
async function withProfile(session: SessionUser): Promise<SessionUser> {
  if (session.personaName) return session;

  try {
    const summary = await getPlayerSummary(session.steamid, {
      session,
      waitUntil: (work) => after(() => work),
    });
    if (summary.status !== "ok") return session;
    return {
      steamid: session.steamid,
      personaName: summary.data.personaName,
      avatarUrl: summary.data.avatar.medium,
    };
  } catch {
    return session;
  }
}
