/**
 * GET /api/apps/[appid]/players?range=48h|1w|1m|3m|6m|1y|3y|6y|max
 *
 * Concurrent players for the game page (v1.11): the live count, the 24-hour
 * and recorded peaks, and the chart series for one range. See
 * lib/player-counts.ts and lib/player-history.ts.
 *
 * The history is SteamGauge's own recordings; `recordingSince` says from
 * when. Viewing marks the game as of interest, so the hourly sampler keeps
 * recording it for the next 14 days.
 *
 * The answer is the same for every user, so the CDN may share it for five
 * minutes (the live count itself is cached for ten).
 *
 * Since v1.11.1 a database, Steam or ITAD failure no longer fails the
 * request: the answer says what is missing (`current: null`,
 * `recording: "unavailable"`) and carries a labelled estimate where it can.
 */
import { after, NextResponse, type NextRequest } from "next/server";

import { errorResponse, failureResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { buildPlayerHistory, notePlayerInterest } from "@/lib/player-counts";
import { DEFAULT_PLAYER_RANGE, isPlayerRange } from "@/lib/player-history";
import { appIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appid: string }> },
): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const appid = appIdSchema.safeParse((await params).appid);
    if (!appid.success) return errorResponse("invalid_appid", 400);

    const rawRange = request.nextUrl.searchParams.get("range") ?? DEFAULT_PLAYER_RANGE;
    if (!isPlayerRange(rawRange)) return errorResponse("invalid_range", 400);

    const history = await buildPlayerHistory(appid.data, rawRange, {
      session,
      waitUntil: (work) => after(() => work),
    });
    after(() => notePlayerInterest(appid.data));

    const response = NextResponse.json({
      status: "ok",
      data: history,
      meta: { source: "cache", fetchedAt: history.current?.asOf ?? new Date().toISOString(), stale: false },
    });
    // A complete answer is shared for 5 minutes; one missing the live count or
    // the recordings for 1 minute, so it recovers soon after the cause is fixed.
    const complete = history.current !== null && history.recording === "ok";
    response.headers.set(
      "Cache-Control",
      complete ? "public, s-maxage=300, stale-while-revalidate=600" : "public, s-maxage=60, stale-while-revalidate=120",
    );
    return response;
  } catch (err) {
    return failureResponse(err);
  }
}
