/**
 * lib/api/access.ts
 *
 * Who may call each API route (v1.13). One list, so the rule is visible in
 * one place and a test can check every route file against it.
 *
 *   public  Anyone. Signed-out visitors are rate-limited per IP; a session,
 *           if present, only raises limits or adds personal flags.
 *   user    A valid session, or 401 {"error":"auth_required"}. Checked in
 *           the route handler against the `sessions` table; middleware.ts
 *           also turns away requests with no session cookie at all.
 *   cron    `Authorization: Bearer $CRON_SECRET`, or 401.
 *   auth    The sign-in and sign-out flow (own rules, doc 6.2).
 *
 * Paths use Next.js segment names exactly as in app/api.
 */
export type RouteAccess = "public" | "user" | "cron" | "auth";

export const API_ROUTE_ACCESS = {
  "/api/apps/[appid]": "public",
  "/api/apps/[appid]/insights": "public",
  "/api/wishlist/[appid]/history": "public",
  "/api/search": "public",
  "/api/deals": "public",

  "/api/wishlist": "user",
  "/api/wishlist/[appid]": "user",
  "/api/library/store": "user",
  "/api/players/[steamid]/games": "user",

  "/api/cron/track-prices": "cron",
  "/api/cron/sample-players": "cron",

  "/api/auth/steam/login": "auth",
  "/api/auth/steam/callback": "auth",
  "/api/auth/logout": "auth",
} as const satisfies Record<string, RouteAccess>;

/** The user-only routes as middleware patterns (see middleware.ts). */
export const USER_ROUTE_MATCHERS = [
  "/api/wishlist",
  "/api/wishlist/:appid",
  "/api/library/:path*",
  "/api/players/:path*",
] as const;
