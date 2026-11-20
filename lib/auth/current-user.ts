import "server-only";

/**
 * lib/auth/current-user.ts
 *
 * The signed-in user for the current request, for Server Components (v1.13).
 *
 *   getCurrentSession()  The verified session, or null. Cached per request
 *                        with React's `cache`, so the layout (navigation)
 *                        and the page share one database lookup.
 *   getCurrentUser()     The same, with the Steam name and avatar filled in
 *                        for the navigation and the dashboard.
 *
 * Route Handlers keep calling getSessionUser with the request's cookie.
 */
import { cookies } from "next/headers";
import { after } from "next/server";
import { cache } from "react";

import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { getPlayerSummary } from "@/lib/steam/endpoints";

export const getCurrentSession = cache(async (): Promise<SessionUser | null> => {
  const cookieStore = await cookies();
  return getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
});

export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const session = await getCurrentSession();
  return session ? withProfile(session) : null;
});

/**
 * The sign-in callback stores only the SteamID, so a brand-new user has no
 * name or avatar yet. On that first visit, fetch the summary once (which also
 * fills the `users` row). Returning users skip this entirely, so the page
 * normally renders without waiting on Steam. Any failure falls back to the
 * bare session: a missing avatar must not block the page.
 */
export async function withProfile(session: SessionUser): Promise<SessionUser> {
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
