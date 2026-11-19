/**
 * GET /api/library/store
 *
 * Store data for the signed-in user's library (v1.10): header art, release
 * date, current US price and top tag names per owned game, for the
 * Dashboard's sorting, tag filter and detailed cards. See lib/library.ts.
 *
 * Always the session's own library: there is no SteamID in the URL, so one
 * user cannot ask for another's. Statuses as GET /api/players/[steamid]/games
 * ("private" when the library is private).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { buildLibraryStore } from "@/lib/library";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A cold large library is up to 40 GetItems calls, 3 at a time.
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const result = await buildLibraryStore(session.steamid, {
      session,
      waitUntil: (work) => after(() => work),
    });

    // Built from one user's library: never stored by the CDN or a shared cache.
    return resultResponse(result, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}
