/**
 * GET /api/search?q=<text>
 *
 * Global search for the dropdown in the top bar: up to 8 games with capsule
 * art, release year and price, ranked by how well their titles match,
 * forgiving typos. See lib/game-search.ts.
 *
 * Requires a session. Each signed-in user may search SEARCH_PER_MINUTE times
 * a minute (the box is debounced, so normal typing uses a few); the answers
 * themselves are cached for everyone, so popular searches cost nothing.
 *
 * Requires Next.js 15.1 or later (`after`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE, sha256Hex } from "@/lib/auth/shared";
import { searchGames } from "@/lib/game-search";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Searches per signed-in user per minute. */
export const SEARCH_PER_MINUTE = 60;
/** Longest raw query accepted; anything longer is not a game title. */
const MAX_QUERY_LENGTH = 100;

async function allowSearch(steamid: string): Promise<boolean> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("take_quota", {
    // Hashed: rate_buckets never holds a SteamID.
    p_upstream: `user:${sha256Hex(steamid).slice(0, 24)}:search`,
    p_kind: "minute",
    p_window: windowStart,
    p_ceiling: SEARCH_PER_MINUTE,
    p_cost: 1,
  });
  if (error) throw new Error("rate limit check failed");
  return data === true;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const query = request.nextUrl.searchParams.get("q") ?? "";
    if (query.length > MAX_QUERY_LENGTH) return errorResponse("invalid_query", 400);

    if (!(await allowSearch(session.steamid))) return errorResponse("rate_limited", 429, 30);

    const result = await searchGames(query, { session, waitUntil: (work) => after(() => work) });
    // Not personal, but per signed-in user: the browser may reuse it briefly.
    return resultResponse(result, "private, max-age=300");
  } catch (err) {
    return failureResponse(err);
  }
}
