/**
 * /deals
 *
 * Server Component. Verifies the `__Host-session` cookie against the
 * `sessions` table, redirects signed-out visitors to the landing page, and
 * renders the client view. The deals themselves are loaded by the client
 * from GET /api/deals, so this page never waits on Steam.
 *
 * Requires Next.js 15 or later (async `cookies`).
 */
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { DealsView } from "@/components/deals-view";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE, SIGNED_OUT_PATH } from "@/lib/auth/shared";

export const metadata: Metadata = { title: "Deals · SteamLite" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function DealsPage() {
  const cookieStore = await cookies();
  const session = await getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);

  if (!session) {
    redirect(SIGNED_OUT_PATH);
  }

  return <DealsView user={session} />;
}
