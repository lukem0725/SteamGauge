/**
 * GET /api/wishlist/[appid]/history
 *
 * Price history for one app, plus whether the current price is the lowest on
 * record. Requires a session.
 *
 *   With ITAD_API_KEY  IsThereAnyDeal's multi-year log of Steam price changes,
 *                      cached for 12 hours and shared by all users. The newest
 *                      logged price is the current price, so no Steam call.
 *   Otherwise, or if ITAD does not know the game
 *                      SteamGauge's own daily record (lib/price-history.ts),
 *                      compared with the current price from the store.
 *
 * The history is not personal, so any signed-in user may read it for any app.
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
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
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const appid = appIdSchema.safeParse((await params).appid);
    if (!appid.success) return errorResponse("invalid_appid", 400);

    const context = { session, waitUntil: (work: Promise<void>) => after(() => work) };

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
          return resultResponse({ status: "ok", data: history, meta: itad.meta }, "private, no-store");
        }
      } catch {
        // ITAD unavailable or its budget spent: fall through to our own record.
      }
    }

    // The current price comes through the cache pipeline. If it was just
    // fetched from Steam, that fetch has already been added to the history.
    const current = await getAppPrice(appid.data, DEFAULT_COUNTRY_CODE, context);
    if (current.status !== "ok") return errorResponse("app_not_found", 404);

    const history = await loadPriceHistory(
      appid.data,
      DEFAULT_COUNTRY_CODE,
      current.data.price?.final ?? null,
    );
    return resultResponse({ status: "ok", data: history, meta: current.meta }, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}
