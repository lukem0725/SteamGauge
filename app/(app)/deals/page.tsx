/**
 * /deals
 *
 * Server Component. Verifies the `__Host-session` cookie against the
 * `sessions` table and, since v1.13, also serves signed-out visitors (the
 * same deals, without personal flags, filters or Watch buttons), and
 * renders the client view. The deals themselves are loaded by the client
 * from GET /api/deals, so this page never waits on Steam.
 *
 * Since v1.14 this is also the home view: "/" redirects here, and so do
 * sign-outs and failed sign-ins. A failed sign-in arrives with
 * ?auth_error=<code>, shown as a notice above the table.
 *
 * Requires Next.js 15 or later (async `cookies`).
 */
import type { Metadata } from "next";

import { AuthErrorNotice } from "@/components/auth-error-notice";
import { DealsView } from "@/components/deals-view";
import { authErrorMessage } from "@/lib/auth/auth-errors";
import { getCurrentSession } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Deals · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function DealsPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string | string[] }>;
}) {
  // Public (v1.13): a session only adds the personal flags and filters.
  // A database outage shows the public deals rather than an error screen.
  const [session, { auth_error: raw }] = await Promise.all([
    getCurrentSession().catch(() => null),
    searchParams,
  ]);
  // A stale error link means nothing once the visitor is signed in.
  const message = session ? null : authErrorMessage(raw);
  return (
    <DealsView user={session} notice={message ? <AuthErrorNotice message={message} /> : null} />
  );
}
