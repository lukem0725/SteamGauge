/**
 * GET /api/apps/[appid]/insights?mode=full|card
 *
 * One game's extra facts: live concurrent players, developers, publishers,
 * franchise, genres, descriptors and tags, and (mode=full) its current price
 * at every store ITAD tracks. Built in lib/game-insights.ts from shared,
 * cached sources.
 *
 *   mode=full   An expanded Deals row (default): includes store prices.
 *   mode=card   A Wishlist card: the same facts, genres included, without
 *               the store price list.
 *
 * Requires a session, so anonymous traffic cannot spend our quota. The data
 * is not personal, so the browser may reuse it for a minute.
 *
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import {
  INSIGHTS_CDN,
  NO_SHARED_CACHE,
  PREFETCH_PER_MINUTE,
  isPrefetch,
  sharedCacheControl,
} from "@/lib/api/game-cache";
import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { takeUserQuota } from "@/lib/api/user-limit";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { buildGameInsights } from "@/lib/game-insights";
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

    const modeParam = request.nextUrl.searchParams.get("mode") ?? "full";
    if (modeParam !== "full" && modeParam !== "card") return errorResponse("invalid_mode", 400);

    // Hover prefetch (lib/api/game-cache.ts): limited per user, lower quota
    // tier, and refused rather than answered with degraded data.
    const prefetch = isPrefetch(request);
    if (prefetch && !(await takeUserQuota(session.steamid, "prefetch", PREFETCH_PER_MINUTE))) {
      return errorResponse("prefetch_declined", 503);
    }

    const result = await buildGameInsights(appid.data, modeParam, {
      session,
      waitUntil: (work) => after(() => work),
      priority: prefetch ? "prefetch" : "interactive",
    });

    const complete = result.status === "ok" && result.data.unavailable.length === 0;
    if (prefetch && !complete) return errorResponse("prefetch_declined", 503);

    // Same for every user: a complete answer may be shared by the CDN.
    return resultResponse(result, complete ? sharedCacheControl(result.meta, INSIGHTS_CDN) : NO_SHARED_CACHE);
  } catch (err) {
    if (isPrefetch(request)) return errorResponse("prefetch_declined", 503);
    return failureResponse(err);
  }
}
