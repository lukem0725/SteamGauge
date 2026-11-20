import "server-only";

/**
 * lib/api/visitor-limit.ts
 *
 * Request limits for the public routes (v1.13), which signed-out visitors
 * can now call. A signed-in caller is counted per user, as before
 * (lib/api/user-limit.ts); a signed-out caller per IP address, under a keyed
 * hash of the address (`ip:<32 hex>:<name>`), never the address itself.
 * Signed-out visitors get lower limits, because one IP can hide many of them
 * and they spend the shared Steam and ITAD budgets just the same.
 */
import type { NextRequest } from "next/server";

import { takeUserQuota } from "@/lib/api/user-limit";
import { clientIpTag } from "@/lib/auth/shared";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export interface VisitorLimit {
  /** Per signed-in user per minute. */
  readonly signedIn: number;
  /** Per IP address per minute, for signed-out visitors. */
  readonly anonymous: number;
}

/** The rate_buckets name for one IP's limit. Exported for tests. */
export function ipBucket(ipTag: string, name: string): string {
  return `ip:${ipTag}:${name}`;
}

/**
 * Counts one request against this caller's per-minute limit.
 *
 * @returns false when this minute's limit is already used up.
 * @throws when the database cannot be asked (callers answer with an error).
 */
export async function takeVisitorQuota(
  request: NextRequest,
  session: { readonly steamid: string } | null,
  name: string,
  limit: VisitorLimit,
): Promise<boolean> {
  if (session) return takeUserQuota(session.steamid, name, limit.signedIn);
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("take_quota", {
    p_upstream: ipBucket(clientIpTag(request), name),
    p_kind: "minute",
    p_window: windowStart,
    p_ceiling: limit.anonymous,
    p_cost: 1,
  });
  if (error) throw new Error("rate limit check failed");
  return data === true;
}
