/**
 * middleware.ts (v1.13)
 *
 * A fast, early "no" for the user-only API routes (lib/api/access.ts): a
 * request without a well-formed session cookie gets 401
 * {"error":"auth_required"} at the edge, before a function starts or the
 * database is asked.
 *
 * This is not the security check. Only the database can say whether a
 * session is real, unexpired and not signed out, so every user-only route
 * handler still verifies the cookie with getSessionUser, and would answer
 * 401 the same way if this file were deleted. Public routes and pages are
 * not matched at all: signed-out visitors browse Deals, search and game
 * pages, and Dashboard and Wishlist render a "Steam Account Required" card.
 */
import { NextResponse, type NextRequest } from "next/server";

/** Same name as SESSION_COOKIE in lib/auth/shared.ts (not imported: that module is server-only Node code). */
const SESSION_COOKIE = "__Host-session";
/** Session tokens are 32 random bytes in base64url: exactly 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function middleware(request: NextRequest): NextResponse {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && TOKEN_SHAPE.test(token)) return NextResponse.next();
  const response = NextResponse.json({ error: "auth_required" }, { status: 401 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

// Must be a literal for Next.js. Kept equal to USER_ROUTE_MATCHERS in
// lib/api/access.ts by a test. "/api/wishlist/:appid" is one segment, so the
// public price history at /api/wishlist/[appid]/history is not matched.
export const config = {
  matcher: ["/api/wishlist", "/api/wishlist/:appid", "/api/library/:path*", "/api/players/:path*"],
};
