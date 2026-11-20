/**
 * GET /api/auth/steam/login
 *
 * Starts "Sign in through Steam" (architecture doc 6.2, step 1).
 *
 *   1. Creates a random `state` value and stores it in a short-lived
 *      __Host- cookie.
 *   2. Redirects (307) to Steam's OpenID 2.0 endpoint. The same `state` rides
 *      along inside `return_to`, so the callback can prove that the browser
 *      finishing the sign-in is the one that started it.
 *
 * Link to this route with a plain <a href>, not next/link. A prefetch would
 * issue a fresh state cookie and break a sign-in already in progress.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { safeReturnPath } from "@/lib/auth/sign-in-link";
import {
  CALLBACK_PATH,
  OPENID_IDENTIFIER_SELECT,
  OPENID_NS,
  RETURN_COOKIE,
  SIGNED_OUT_PATH,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  STEAM_OPENID_ENDPOINT,
  allowAuthRequest,
  authCookieOptions,
  errorName,
  getAppOrigin,
  logAuthFailure,
} from "@/lib/auth/shared";

export const runtime = "nodejs"; // node:crypto
export const dynamic = "force-dynamic"; // never cache or prerender

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const origin = getAppOrigin();

    if (!(await allowAuthRequest(request))) {
      logAuthFailure("login", "rate_limited");
      const url = new URL(SIGNED_OUT_PATH, origin);
      url.searchParams.set("auth_error", "rate_limited");
      return noStore(NextResponse.redirect(url, 303));
    }

    // 256 bits from the OS CSPRNG, URL-safe.
    const state = randomBytes(32).toString("base64url");

    const returnTo = new URL(CALLBACK_PATH, origin);
    returnTo.searchParams.set("state", state);

    // Valve's standard OpenID 2.0 request. `identifier_select` asks Steam to
    // report whichever account the user signs in with.
    const steamUrl = new URL(STEAM_OPENID_ENDPOINT);
    steamUrl.searchParams.set("openid.ns", OPENID_NS);
    steamUrl.searchParams.set("openid.mode", "checkid_setup");
    steamUrl.searchParams.set("openid.return_to", returnTo.toString());
    steamUrl.searchParams.set("openid.realm", origin);
    steamUrl.searchParams.set("openid.identity", OPENID_IDENTIFIER_SELECT);
    steamUrl.searchParams.set("openid.claimed_id", OPENID_IDENTIFIER_SELECT);

    const response = NextResponse.redirect(steamUrl, 307);
    response.cookies.set(STATE_COOKIE, state, authCookieOptions(STATE_TTL_SECONDS));
    // Where to land afterwards (v1.13): one of our own pages, or nothing.
    const next = safeReturnPath(request.nextUrl.searchParams.get("next"));
    response.cookies.set(RETURN_COOKIE, next ?? "", authCookieOptions(next ? STATE_TTL_SECONDS : 0));
    return noStore(response);
  } catch (err) {
    // Missing configuration or an unreachable database. There is no safe
    // origin to redirect to if APP_ORIGIN itself is the problem, so answer
    // directly. Nothing about the cause is sent to the browser.
    logAuthFailure("login", "server_error", { errorName: errorName(err) });
    return noStore(
      NextResponse.json({ error: "sign_in_unavailable" }, { status: 503 }),
    );
  }
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
