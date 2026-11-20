/**
 * lib/auth/sign-in-link.ts
 *
 * The "Sign in with Steam" link, and the return path it carries (v1.13).
 * Pure and dependency-free, so both Server and Client Components use it.
 *
 * Signing in from /wishlist brings the visitor back to /wishlist. The return
 * path travels as `?next=` to /api/auth/steam/login, which keeps it in a
 * short-lived cookie until Steam sends the browser back. It is checked here
 * on the way in and again on the way out, and only SteamGauge's own pages
 * are accepted: an open redirect would let a crafted link send a freshly
 * signed-in user anywhere.
 */

/** The OpenID start route. A plain <a href>, never next/link (doc 6.2). */
export const SIGN_IN_PATH = "/api/auth/steam/login";

/**
 * SteamGauge pages a sign-in may return to, with an optional plain query
 * string (for example /search?q=witcher). No "//", no backslashes, no
 * fragments, no other hosts.
 */
const RETURN_PATH = /^\/(?:dashboard|wishlist|deals|search|game\/[1-9]\d{0,6})(?:\?[A-Za-z0-9_\-.~%=&+]{0,200})?$/;

/** The path itself when it is one of ours, otherwise null. */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.length > 240) return null;
  return RETURN_PATH.test(value) ? value : null;
}

/** "/api/auth/steam/login?next=%2Fwishlist", or the bare route for anything else. */
export function signInHref(returnTo?: string | null): string {
  const next = safeReturnPath(returnTo);
  return next ? `${SIGN_IN_PATH}?next=${encodeURIComponent(next)}` : SIGN_IN_PATH;
}
