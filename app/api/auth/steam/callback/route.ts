/**
 * GET /api/auth/steam/callback
 *
 * Finishes "Sign in through Steam" (architecture doc 6.2, steps 2 and 3).
 * Steam redirects the browser here with an OpenID 2.0 assertion in the query
 * string. Nothing in that query string is trusted until every check passes:
 *
 *   1. `state` matches the __Host- cookie set by /login          (CSRF)
 *   2. The assertion is well formed and addressed to us
 *   3. Steam confirms it server-to-server (check_authentication)
 *   4. The response nonce has not been used before               (replay)
 *
 * Only then: upsert the user, create a session, set the session cookie.
 *
 * The session token is 256 random bits. The browser gets the raw token in an
 * httpOnly cookie; the database stores only its SHA-256 hash, so a database
 * leak does not yield usable sessions.
 */
import { randomBytes } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import {
  CALLBACK_PATH,
  OPENID_NS,
  POST_LOGIN_PATH,
  SIGNED_OUT_PATH,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  STATE_COOKIE,
  STEAM_OPENID_ENDPOINT,
  allowAuthRequest,
  authCookieOptions,
  constantTimeEqual,
  errorName,
  getAppOrigin,
  logAuthFailure,
  sha256Hex,
} from "@/lib/auth/shared";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs"; // node:crypto
export const dynamic = "force-dynamic"; // never cache or prerender

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** The SteamID64 is taken from this capture group and nowhere else (doc 6.2). */
const CLAIMED_ID_PATTERN = /^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/;

/** Every field we rely on must be covered by Steam's signature. */
const REQUIRED_SIGNED_FIELDS = [
  "op_endpoint",
  "claimed_id",
  "identity",
  "return_to",
  "response_nonce",
  "assoc_handle",
] as const;

/** OpenID nonce: UTC timestamp, then up to 235 printable characters. */
const NONCE_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)[\x21-\x7e]{0,235}$/;
/** Must stay below the 10-minute retention of openid_nonces rows. */
const NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const NONCE_MAX_FUTURE_SKEW_MS = 2 * 60 * 1000;

const STEAM_VERIFY_TIMEOUT_MS = 5_000;
const MAX_QUERY_LENGTH = 4_096;
const PG_UNIQUE_VIOLATION = "23505";

/** Codes shown to the browser as ?auth_error=. Deliberately coarse. */
type FailureCode =
  | "cancelled"
  | "invalid_state"
  | "verification_failed"
  | "rate_limited"
  | "server_error";

class SteamUnavailableError extends Error {
  constructor() {
    super("Steam OpenID endpoint did not give a usable answer");
    this.name = "SteamUnavailableError";
  }
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function GET(request: NextRequest): Promise<NextResponse> {
  let origin: string;
  try {
    origin = getAppOrigin();
  } catch (err) {
    // Without a trusted origin there is nowhere safe to redirect.
    logAuthFailure("callback", "server_error", { errorName: errorName(err) });
    return noStore(NextResponse.json({ error: "sign_in_unavailable" }, { status: 503 }));
  }

  try {
    if (!(await allowAuthRequest(request))) {
      return fail(origin, "rate_limited", "rate_limited");
    }

    const params = request.nextUrl.searchParams;
    if (request.nextUrl.search.length > MAX_QUERY_LENGTH) {
      return fail(origin, "verification_failed", "query_too_long");
    }

    // ---- 1. CSRF: state in the URL must equal state in the cookie ----------
    const stateParam = params.get("state");
    const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
    if (!stateParam || !stateCookie || !constantTimeEqual(stateParam, stateCookie)) {
      return fail(origin, "invalid_state", "state_mismatch");
    }

    // ---- 2. Shape of the assertion -----------------------------------------
    // A repeated parameter could make us validate one value while Steam
    // verifies another. Reject any duplicate outright.
    if (hasDuplicateKeys(params)) {
      return fail(origin, "verification_failed", "duplicate_parameter");
    }

    const mode = params.get("openid.mode");
    if (mode === "cancel") {
      return fail(origin, "cancelled", "user_cancelled");
    }
    if (mode !== "id_res") {
      return fail(origin, "verification_failed", "unexpected_mode");
    }

    if (
      params.get("openid.ns") !== OPENID_NS ||
      params.get("openid.op_endpoint") !== STEAM_OPENID_ENDPOINT
    ) {
      return fail(origin, "verification_failed", "wrong_provider");
    }

    // The assertion must have been issued for this exact callback and state.
    const expectedReturnTo = new URL(CALLBACK_PATH, origin);
    expectedReturnTo.searchParams.set("state", stateCookie);
    if (params.get("openid.return_to") !== expectedReturnTo.toString()) {
      return fail(origin, "verification_failed", "return_to_mismatch");
    }

    const claimedId = params.get("openid.claimed_id") ?? "";
    const steamid = CLAIMED_ID_PATTERN.exec(claimedId)?.[1];
    if (!steamid || params.get("openid.identity") !== claimedId) {
      return fail(origin, "verification_failed", "bad_claimed_id");
    }

    if (!params.get("openid.sig") || !params.get("openid.assoc_handle")) {
      return fail(origin, "verification_failed", "missing_signature");
    }
    const signed = new Set((params.get("openid.signed") ?? "").split(","));
    if (!REQUIRED_SIGNED_FIELDS.every((field) => signed.has(field))) {
      return fail(origin, "verification_failed", "unsigned_field");
    }

    const nonce = params.get("openid.response_nonce") ?? "";
    if (!isNonceTimely(nonce)) {
      return fail(origin, "verification_failed", "bad_nonce");
    }

    // ---- 3. Server-to-server confirmation with Steam -----------------------
    // Nothing above proves the assertion is genuine; anyone can type those
    // parameters into a URL. Only Steam's own answer does.
    if (!(await steamConfirmsAssertion(params))) {
      return fail(origin, "verification_failed", "steam_rejected");
    }

    // ---- 4. Replay protection ----------------------------------------------
    // The nonce is the table's primary key, so a second use fails atomically
    // even if two requests race.
    const db = getSupabaseAdmin();
    const nonceInsert = await db.from("openid_nonces").insert({ nonce });
    if (nonceInsert.error) {
      if (nonceInsert.error.code === PG_UNIQUE_VIOLATION) {
        return fail(origin, "verification_failed", "nonce_replayed");
      }
      return fail(origin, "server_error", "nonce_write_failed", nonceInsert.error.code);
    }

    // ---- 5. Upsert the user ------------------------------------------------
    // Only steamid and last_login_at are written. On conflict, other columns
    // (persona_name, avatar_url, profile_url, created_at) keep their values;
    // the profile pipeline fills those from GetPlayerSummaries.
    const nowMs = Date.now();
    const userUpsert = await db
      .from("users")
      .upsert(
        { steamid, last_login_at: new Date(nowMs).toISOString() },
        { onConflict: "steamid" },
      );
    if (userUpsert.error) {
      return fail(origin, "server_error", "user_write_failed", userUpsert.error.code);
    }

    // ---- 6. Create the session ---------------------------------------------
    // A brand-new token on every sign-in, so a pre-existing cookie can never
    // be promoted into an authenticated session (session fixation).
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionInsert = await db.from("sessions").insert({
      token_hash: sha256Hex(sessionToken),
      user_steamid: steamid,
      expires_at: new Date(nowMs + SESSION_TTL_SECONDS * 1000).toISOString(),
    });
    if (sessionInsert.error) {
      return fail(origin, "server_error", "session_write_failed", sessionInsert.error.code);
    }

    // ---- 7. Hand the browser its session and send it home ------------------
    const response = NextResponse.redirect(new URL(POST_LOGIN_PATH, origin), 303);
    response.cookies.set(SESSION_COOKIE, sessionToken, authCookieOptions(SESSION_TTL_SECONDS));
    clearStateCookie(response);
    return noStore(response);
  } catch (err) {
    const reason = err instanceof SteamUnavailableError ? "steam_unavailable" : "unexpected";
    logAuthFailure("callback", reason, { errorName: errorName(err) });
    return failureRedirect(origin, "server_error");
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function hasDuplicateKeys(params: URLSearchParams): boolean {
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function isNonceTimely(nonce: string): boolean {
  const match = NONCE_PATTERN.exec(nonce);
  if (!match?.[1]) return false;
  const issuedAt = Date.parse(match[1]);
  if (Number.isNaN(issuedAt)) return false;
  const age = Date.now() - issuedAt;
  return age <= NONCE_MAX_AGE_MS && age >= -NONCE_MAX_FUTURE_SKEW_MS;
}

/**
 * Asks Steam whether it really issued this assertion.
 *
 * Per OpenID 2.0 direct verification, every openid.* field is posted back
 * unchanged with the mode switched to check_authentication. Steam answers in
 * key:value lines; the assertion is genuine only if one line is exactly
 * `is_valid:true`.
 *
 * @returns true only on an explicit `is_valid:true`.
 * @throws SteamUnavailableError if Steam cannot be reached or answers with an
 *         error, so an outage is not reported to the user as a forged login.
 */
async function steamConfirmsAssertion(params: URLSearchParams): Promise<boolean> {
  const body = new URLSearchParams();
  for (const [key, value] of params) {
    if (key.startsWith("openid.")) body.set(key, value);
  }
  body.set("openid.mode", "check_authentication");

  let text: string;
  try {
    const response = await fetch(STEAM_OPENID_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/plain",
      },
      body: body.toString(),
      redirect: "error", // the endpoint is fixed; never follow it elsewhere
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(STEAM_VERIFY_TIMEOUT_MS),
    });
    if (!response.ok) throw new SteamUnavailableError();
    text = (await response.text()).slice(0, 2_048);
  } catch {
    // The original error is dropped: nothing from the exchange is logged.
    throw new SteamUnavailableError();
  }

  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return fields.get("ns") === OPENID_NS && fields.get("is_valid") === "true";
}

/** Logs the precise internal reason, shows the browser only a coarse code. */
function fail(
  origin: string,
  code: FailureCode,
  internalReason: string,
  dbCode?: string,
): NextResponse {
  logAuthFailure("callback", internalReason, { dbCode });
  return failureRedirect(origin, code);
}

function failureRedirect(origin: string, code: FailureCode): NextResponse {
  const url = new URL(SIGNED_OUT_PATH, origin);
  url.searchParams.set("auth_error", code);
  const response = NextResponse.redirect(url, 303);
  clearStateCookie(response); // a state value is single-use, pass or fail
  return noStore(response);
}

function clearStateCookie(response: NextResponse): void {
  response.cookies.set(STATE_COOKIE, "", authCookieOptions(0));
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  return response;
}
