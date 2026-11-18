import "server-only";

/**
 * lib/api/user-limit.ts
 *
 * Per-user request limits, counted in rate_buckets with take_quota like every
 * other budget (doc 5.6). The bucket name holds a hash of the SteamID, never
 * the SteamID itself: `user:<first 24 hex of sha256(steamid)>:<name>`.
 */
import { sha256Hex } from "@/lib/auth/shared";
import { getSupabaseAdmin } from "@/lib/supabase/server";

/** The rate_buckets name for one user's limit. Exported for tests. */
export function userBucket(steamid: string, name: string): string {
  return `user:${sha256Hex(steamid).slice(0, 24)}:${name}`;
}

/**
 * Counts one request against `perMinute` for this user.
 *
 * @returns false when this minute's limit is already used up.
 * @throws when the database cannot be asked (callers answer with an error).
 */
export async function takeUserQuota(steamid: string, name: string, perMinute: number): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("take_quota", {
    p_upstream: userBucket(steamid, name),
    p_kind: "minute",
    p_window: windowStart,
    p_ceiling: perMinute,
    p_cost: 1,
  });
  if (error) throw new Error("rate limit check failed");
  return data === true;
}
