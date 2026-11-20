/**
 * /  (v1.14)
 *
 * Opening SteamGauge lands on Deals, signed in or not: this route only
 * redirects to /deals. It reads no cookie and makes no database call, so it
 * cannot fail and never shows a sign-in wall.
 *
 * Redirecting (rather than rendering Deals here too) keeps one address for
 * the view, so the Deals tab is highlighted, bookmarks and sign-in return
 * paths agree, and the browser's history holds a single entry. The redirect
 * is temporary (307) so the home page can change later without browsers
 * having cached it.
 *
 * Older links to /?auth_error=<code> keep working: a known code is carried
 * over, anything else becomes server_error (lib/auth/auth-errors.ts).
 */
import { redirect } from "next/navigation";

import { authErrorCode } from "@/lib/auth/auth-errors";
import { HOME_PATH } from "@/lib/auth/shared";

// Reads the query string: never prerender.
export const dynamic = "force-dynamic";

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<{ auth_error?: string | string[] }>;
}): Promise<never> {
  const { auth_error: raw } = await searchParams;
  const code = authErrorCode(raw);
  redirect(code ? `${HOME_PATH}?auth_error=${code}` : HOME_PATH);
}
