/**
 * GET /api/cron/sample-players
 *
 * Records the current player count of watched games and games viewed in the
 * last 14 days (v1.11), at most 300 per run, so their history charts have no
 * gaps between visits. Then drops 10-minute rows older than 31 days.
 * See lib/player-counts.ts.
 *
 * Meant to run hourly. Vercel's Hobby plan only runs cron jobs once a day (an
 * hourly schedule fails to deploy), so this route is NOT in vercel.json.
 * Call it hourly from any scheduler with `Authorization: Bearer $CRON_SECRET`:
 * the included GitHub Actions workflow (.github/workflows/sample-players.yml),
 * a Vercel Pro cron entry, or Supabase pg_cron with pg_net.
 */
import { NextResponse, after, type NextRequest } from "next/server";

import { isCronAuthorized } from "@/lib/api/cron-auth";
import { errorResponse, failureResponse } from "@/lib/api/respond";
import { samplePlayers } from "@/lib/player-counts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 reads, 5 at a time.
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isCronAuthorized(request.headers.get("authorization"))) {
      return errorResponse("unauthorized", 401);
    }
    const result = await samplePlayers({ waitUntil: (work) => after(() => work) });
    const response = NextResponse.json(result);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return failureResponse(err);
  }
}
