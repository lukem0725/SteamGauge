/**
 * GET /api/search?q=<text>
 *
 * Global search for the dropdown in the top bar: up to 8 games with capsule
 * art, release year and price, ranked by how well their titles match,
 * forgiving typos. See lib/game-search.ts.
 *
 * Public since v1.13 (lib/api/access.ts). Each signed-in user may search
 * SEARCH_PER_MINUTE times a minute, each signed-out IP
 * SEARCH_PER_MINUTE_ANONYMOUS times (the box is debounced, so normal typing
 * uses a few); the answers themselves are cached for everyone, so popular
 * searches cost nothing.
 *
 * Requires Next.js 15.1 or later (`after`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { takeVisitorQuota } from "@/lib/api/visitor-limit";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { searchGames } from "@/lib/game-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Searches per signed-in user per minute. */
export const SEARCH_PER_MINUTE = 60;
/** Searches per IP per minute for signed-out visitors (v1.13). */
export const SEARCH_PER_MINUTE_ANONYMOUS = 30;
/** Longest raw query accepted; anything longer is not a game title. */
const MAX_QUERY_LENGTH = 100;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Public since v1.13: a session only changes which limit applies.
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);

    const query = request.nextUrl.searchParams.get("q") ?? "";
    if (query.length > MAX_QUERY_LENGTH) return errorResponse("invalid_query", 400);

    const limit = { signedIn: SEARCH_PER_MINUTE, anonymous: SEARCH_PER_MINUTE_ANONYMOUS };
    if (!(await takeVisitorQuota(request, session, "search", limit))) {
      return errorResponse("rate_limited", 429, 30);
    }

    const result = await searchGames(query, { session, waitUntil: (work) => after(() => work) });
    // Not personal: the browser may reuse it briefly.
    return resultResponse(result, "private, max-age=300");
  } catch (err) {
    return failureResponse(err);
  }
}
