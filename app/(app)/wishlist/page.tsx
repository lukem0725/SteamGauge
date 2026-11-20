/**
 * /wishlist
 *
 * Server Component. Verifies the `__Host-session` cookie against the
 * `sessions` table, shows signed-out visitors the "Steam Account Required"
 * card (v1.13; before, it redirected them to the landing page), and
 * renders the client view. The list itself is loaded by the client from
 * GET /api/wishlist, so this page never waits on Steam.
 *
 * Requires Next.js 15 or later (async `cookies`).
 */
import type { Metadata } from "next";

import { SignInRequired } from "@/components/sign-in-required";
import { WishlistView } from "@/components/wishlist-view";
import { getCurrentSession } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Wishlist · SteamGauge" };

// Depends on a cookie: never prerender or cache this page.
export const dynamic = "force-dynamic";

export default async function WishlistPage() {
  const session = await getCurrentSession();
  if (!session) return <SignInRequired returnTo="/wishlist" title="Wishlist" />;
  return <WishlistView user={session} />;
}
