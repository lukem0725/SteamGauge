/**
 * lib/auth/session.ts
 *
 * Turns the `__Host-session` cookie into a verified user, or null.
 *
 * The cookie holds an opaque random token. Only its SHA-256 hash is stored in
 * `sessions.token_hash` (architecture doc 6.2), so verification is: hash the
 * cookie, find the row, check it has not expired, load the user.
 *
 *   Server Component:  getSessionUser((await cookies()).get(SESSION_COOKIE)?.value)
 *   Route Handler:     getSessionUser(request.cookies.get(SESSION_COOKIE)?.value)
 */
import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase/server";

import { sha256Hex } from "./shared";

/**
 * The verified identity behind a request. Plain and serialisable, so a Server
 * Component can pass it to a Client Component. It never contains the token.
 */
export interface SessionUser {
  readonly steamid: string;
  /** Null until the player's summary has been fetched for the first time. */
  readonly personaName: string | null;
  readonly avatarUrl: string | null;
}

/** 32 random bytes in base64url, as issued by the sign-in callback. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * @returns the signed-in user, or null if the cookie is missing, malformed,
 *          unknown, or expired.
 * @throws if Supabase cannot be read. A database outage is surfaced as an
 *         error rather than treated as "signed out".
 */
export async function getSessionUser(token: string | undefined): Promise<SessionUser | null> {
  // Cheap rejection of junk before spending a database query on it.
  if (!token || !TOKEN_PATTERN.test(token)) return null;

  const db = getSupabaseAdmin();

  const session = await db
    .from("sessions")
    .select("user_steamid,expires_at")
    .eq("token_hash", sha256Hex(token))
    .maybeSingle();
  if (session.error) throw new Error("session lookup failed");

  const row = session.data as { user_steamid?: unknown; expires_at?: unknown } | null;
  if (!row || typeof row.user_steamid !== "string" || typeof row.expires_at !== "string") {
    return null;
  }
  if (!(Date.parse(row.expires_at) > Date.now())) return null;

  const user = await db
    .from("users")
    .select("steamid,persona_name,avatar_url")
    .eq("steamid", row.user_steamid)
    .maybeSingle();
  if (user.error) throw new Error("user lookup failed");

  const profile = user.data as { persona_name?: unknown; avatar_url?: unknown } | null;
  if (!profile) return null;

  return {
    steamid: row.user_steamid,
    personaName: typeof profile.persona_name === "string" ? profile.persona_name : null,
    avatarUrl: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
  };
}
