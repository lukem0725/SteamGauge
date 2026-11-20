/**
 * lib/auth/shared.ts
 *
 * Constants and small helpers shared by the Steam sign-in routes
 * (app/api/auth/steam/login and .../callback) and, later, by the session
 * reader. Server-only. See architecture doc 6.2.
 *
 * Required environment variables:
 *   APP_ORIGIN      Public origin of this deployment, for example
 *                   https://steamgauge.example.com. No path, no trailing slash.
 *                   It is configured, never taken from the Host header, so a
 *                   forged Host cannot change where Steam sends the user back.
 *   SESSION_SECRET  32+ random bytes. Used here as the HMAC key that turns a
 *                   client IP into a rate-limit bucket name.
 */
import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

import { getSupabaseAdmin } from "@/lib/supabase/server";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/**
 * The `__Host-` prefix makes the browser enforce: Secure, Path=/, and no
 * Domain attribute. A subdomain or a plain-http page cannot set or overwrite
 * these cookies.
 */
export const STATE_COOKIE = "__Host-steam_openid_state";
export const SESSION_COOKIE = "__Host-session";
/**
 * Where to go after signing in (v1.13): set by the login route from a
 * checked `?next=`, read and cleared by the callback. Same lifetime as the
 * OpenID state.
 */
export const RETURN_COOKIE = "__Host-steam_return";

/** The user has this long to finish signing in on Steam. */
export const STATE_TTL_SECONDS = 10 * 60;
/** Session lifetime (doc 6.2). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const CALLBACK_PATH = "/api/auth/steam/callback";
export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";
export const OPENID_NS = "http://specs.openid.net/auth/2.0";
export const OPENID_IDENTIFIER_SELECT = "http://specs.openid.net/auth/2.0/identifier_select";

/** Where the browser lands after a successful sign-in. */
export const POST_LOGIN_PATH = "/dashboard";

/**
 * The home view (v1.14): Deals, public to everyone. Opening "/" redirects
 * here, signed in or not.
 */
export const HOME_PATH = "/deals";

/**
 * Where sign-outs and failed sign-ins (with ?auth_error=<code>) are sent.
 * The home view, directly, so there is no extra redirect through "/".
 */
export const SIGNED_OUT_PATH = HOME_PATH;

/** Inbound limit for auth endpoints: 10 requests per minute per IP (doc 6.4). */
const AUTH_RATE_LIMIT_PER_MINUTE = 10;

// -----------------------------------------------------------------------------
// Configuration
// -----------------------------------------------------------------------------

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Returns the configured public origin, validated. */
export function getAppOrigin(): string {
  const raw = process.env.APP_ORIGIN?.trim();
  if (!raw) throw new AuthConfigError("APP_ORIGIN is not set.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuthConfigError("APP_ORIGIN is not a valid URL.");
  }

  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) {
    throw new AuthConfigError("APP_ORIGIN must use https.");
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new AuthConfigError("APP_ORIGIN must be an origin only, with no path or query.");
  }
  return url.origin;
}

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new AuthConfigError("SESSION_SECRET is not set or is shorter than 32 characters.");
  }
  return secret;
}

// -----------------------------------------------------------------------------
// Cookies
// -----------------------------------------------------------------------------

/**
 * Attributes for both auth cookies.
 *
 * SameSite=Lax, not Strict, is required: the browser arrives at the callback
 * by a top-level navigation from steamcommunity.com, and Strict would withhold
 * the state cookie on that request.
 *
 * `secure: true` is unconditional because `__Host-` requires it. Chrome and
 * Firefox accept Secure cookies on http://localhost; Safari does not, so use
 * one of those browsers (or https) for local development.
 */
export function authCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// -----------------------------------------------------------------------------
// Crypto helpers
// -----------------------------------------------------------------------------

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Constant-time string comparison. Safe for inputs of different lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// -----------------------------------------------------------------------------
// Inbound rate limiting
// -----------------------------------------------------------------------------

/**
 * On Vercel, x-forwarded-for is set by the platform and its first entry is the
 * real client. On another host, confirm the proxy overwrites this header;
 * otherwise a client can forge it and dodge the limit.
 */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * A keyed hash of the client's IP address (32 hex). Used in rate-limit
 * bucket names, so `rate_buckets` never holds an address and the tag cannot
 * be reversed without SESSION_SECRET.
 */
export function clientIpTag(request: NextRequest): string {
  return createHmac("sha256", getSessionSecret()).update(clientIp(request), "utf8").digest("hex").slice(0, 32);
}

/**
 * Charges one request to this IP's per-minute auth budget.
 *
 * @returns true if the request may proceed, false if the limit is reached.
 * @throws if the limit cannot be checked. Callers must treat that as a
 *         failure, not as permission.
 */
export async function allowAuthRequest(request: NextRequest): Promise<boolean> {
  // Keyed hash: the bucket name cannot be reversed to an IP address.
  const ipTag = clientIpTag(request);

  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();

  const { data, error } = await getSupabaseAdmin().rpc("take_quota", {
    p_upstream: `ip:${ipTag}:auth`,
    p_kind: "minute",
    p_window: windowStart,
    p_ceiling: AUTH_RATE_LIMIT_PER_MINUTE,
    p_cost: 1,
  });

  if (error) throw new Error("rate limit check failed");
  return data === true;
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------

/**
 * Writes one structured log line for an auth failure.
 *
 * Only a route name, a fixed reason code, and at most an error class name or
 * Postgres error code are recorded. Never pass, and this never logs: query
 * parameters, cookies, tokens, hashes, SteamIDs, IP addresses, or raw error
 * messages (database messages can quote the values involved).
 */
export function logAuthFailure(
  route: "login" | "callback" | "logout",
  reason: string,
  detail?: { errorName?: string; dbCode?: string },
): void {
  console.error(
    JSON.stringify({
      scope: "auth",
      route,
      reason,
      ...(detail?.errorName ? { errorName: detail.errorName } : {}),
      ...(detail?.dbCode ? { dbCode: detail.dbCode } : {}),
    }),
  );
}

/** Extracts a safe-to-log class name from anything thrown. */
export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "NonError";
}
