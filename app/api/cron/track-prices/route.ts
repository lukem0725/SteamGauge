/**
 * GET /api/cron/track-prices
 *
 * Scheduled job. Refreshes the price of every app on anyone's wishlist, so
 * price history keeps growing on days when nobody opens the app. Each live
 * fetch is recorded by the getAppPrice wrapper.
 *
 * Schedule it once a day in vercel.json:
 *
 *     { "crons": [{ "path": "/api/cron/track-prices", "schedule": "17 9 * * *" }] }
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET`. Anything else gets 401.
 * Requires Next.js 15.1 or later (`after`).
 */
import { NextResponse, after, type NextRequest } from "next/server";

import { isCronAuthorized } from "@/lib/api/cron-auth";
import { errorResponse, failureResponse } from "@/lib/api/respond";
import { getAppPrice } from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { DEFAULT_COUNTRY_CODE } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Per run. One Storefront call each at most, against a budget of 150 per
 * 5 minutes, leaving room for people using the app at the same time.
 */
const MAX_APPS_PER_RUN = 100;
const CONCURRENCY = 2;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    if (!isCronAuthorized(request.headers.get("authorization"))) {
      return errorResponse("unauthorized", 401);
    }

    const tracked = await getSupabaseAdmin()
      .from("tracked_apps")
      .select("appid")
      .order("appid", { ascending: true })
      .limit(1000);
    if (tracked.error) throw new Error("tracked apps read failed");

    const rows: unknown[] = Array.isArray(tracked.data) ? tracked.data : [];
    const appids = [
      ...new Set(
        rows
          .map((row) => (row as { appid?: unknown } | null)?.appid)
          .filter((appid): appid is number => Number.isInteger(appid)),
      ),
    ].slice(0, MAX_APPS_PER_RUN);

    let refreshed = 0;
    let failed = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, appids.length) }, async () => {
        while (next < appids.length) {
          const appid = appids[next++] as number;
          try {
            await getAppPrice(appid, DEFAULT_COUNTRY_CODE, {
              priority: "cron",
              waitUntil: (work) => after(() => work),
            });
            refreshed++;
          } catch {
            failed++;
          }
        }
      }),
    );

    const response = NextResponse.json({ apps: appids.length, refreshed, failed });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return failureResponse(err);
  }
}
