/**
 * GET /api/wishlist/[appid]/history
 *
 * Price history for one app, plus whether the current price is the lowest on
 * record. Public since v1.13 (lib/api/access.ts).
 *
 *   With ITAD_API_KEY  IsThereAnyDeal's multi-year log of Steam price changes,
 *                      cached for 12 hours and shared by all users. The newest
 *                      logged price is the current price, so no Steam call.
 *   Otherwise, or if ITAD does not know the game
 *                      SteamGauge's own daily record (lib/price-history.ts),
 *                      compared with the current price from the store.
 *   If ITAD knows the game but could not be read just now (v1.14.1)
 *                      The same short local record, marked
 *                      `pendingFullHistory` and sent `private, no-store`, so
 *                      no cache keeps it. The browser asks again a few times
 *                      (components/game-queries.ts) and the full history
 *                      replaces it. Before v1.14.1 this answer was shared
 *                      like a complete one, so a slow, busy or throttled ITAD
 *                      call left the Deals dropdown (whose hover prefetch
 *                      often makes the second, "busy" request) showing a few
 *                      days of history for up to an hour.
 *
 * The history is not personal, so anyone may read it for any app. Signed-out
 * visitors are limited per IP (PUBLIC_GAME_LIMIT in lib/api/game-cache.ts).
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import {
  HISTORY_CDN,
  NO_SHARED_CACHE,
  PREFETCH_LIMIT,
  PUBLIC_GAME_LIMIT,
  isPrefetch,
  sharedCacheControl,
} from "@/lib/api/game-cache";
import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { takeVisitorQuota } from "@/lib/api/visitor-limit";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { isItadConfigured } from "@/lib/itad/client";
import { loadPriceHistory, summarizePriceHistory } from "@/lib/price-history";
import { getAppPrice, getItadHistory } from "@/lib/steam/endpoints";
import { DEFAULT_COUNTRY_CODE, appIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appid: string }> },
): Promise<NextResponse> {
  try {
    // Public since v1.13: a game's price history is the same for everyone.
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);

    const appid = appIdSchema.safeParse((await params).appid);
    if (!appid.success) return errorResponse("invalid_appid", 400);

    // Hover prefetch (lib/api/game-cache.ts): limited per user, lower quota tier.
    const prefetch = isPrefetch(request);
    if (prefetch && !(await takeVisitorQuota(request, session, "prefetch", PREFETCH_LIMIT))) {
      return errorResponse("prefetch_declined", 503);
    }
    if (!prefetch && !session && !(await takeVisitorQuota(request, null, "game", PUBLIC_GAME_LIMIT))) {
      return errorResponse("rate_limited", 429, 30);
    }

    const context = {
      session,
      waitUntil: (work: Promise<void>) => after(() => work),
      priority: prefetch ? ("prefetch" as const) : ("interactive" as const),
    };

    // True when ITAD should have answered but didn't (timeout, busy, budget,
    // breaker). "ITAD has no record of this game" is not a failure.
    let itadFailed = false;
    if (isItadConfigured()) {
      try {
        const itad = await getItadHistory(appid.data, DEFAULT_COUNTRY_CODE, context);
        if (itad.status === "ok" && itad.data.points.length > 0) {
          const history = summarizePriceHistory(
            appid.data,
            itad.data.points,
            itad.data.currency,
            itad.data.latestFinal,
            "itad",
          );
          // Same for every user: shared by the CDN (lib/api/game-cache.ts).
          return resultResponse(
            { status: "ok", data: history, meta: itad.meta },
            sharedCacheControl(itad.meta, HISTORY_CDN),
          );
        }
      } catch {
        // ITAD unavailable, still being fetched by another request, or its
        // budget spent: show our own record for now, never cached (below).
        itadFailed = true;
      }
    }

    // The fallback below spends Storefront budget, the tightest there is. A
    // guess never does: the browser loads it normally if the row is opened.
    if (prefetch) return errorResponse("prefetch_declined", 503);

    // The current price comes through the cache pipeline. If it was just
    // fetched from Steam, that fetch has already been added to the history.
    const current = await getAppPrice(appid.data, DEFAULT_COUNTRY_CODE, context);
    if (current.status !== "ok") return errorResponse("app_not_found", 404);

    const history = await loadPriceHistory(
      appid.data,
      DEFAULT_COUNTRY_CODE,
      current.data.price?.final ?? null,
    );
    if (itadFailed) {
      // A stand-in, not the answer: no shared or browser HTTP cache may keep
      // it, and the client replaces it once ITAD answers.
      return resultResponse(
        { status: "ok", data: { ...history, pendingFullHistory: true }, meta: current.meta },
        NO_SHARED_CACHE,
      );
    }
    return resultResponse(
      { status: "ok", data: history, meta: current.meta },
      sharedCacheControl(current.meta, HISTORY_CDN),
    );
  } catch (err) {
    if (isPrefetch(request)) return errorResponse("prefetch_declined", 503);
    return failureResponse(err);
  }
}
