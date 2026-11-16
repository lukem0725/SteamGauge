/**
 * GET /api/wishlist/[appid]/history
 *
 * SteamLite's recorded price history for one app, plus whether the current
 * price is the lowest on record (lib/price-history.ts). Requires a session.
 *
 * The history is not personal, so any signed-in user may read it for any
 * app. It lives under /api/wishlist because the wishlist is what shows it.
 *
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { loadPriceHistory } from "@/lib/price-history";
import { getAppPrice } from "@/lib/steam/endpoints";
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

    // The current price comes through the cache pipeline. If it was just
    // fetched from Steam, that fetch has already been added to the history.
    const current = await getAppPrice(appid.data, DEFAULT_COUNTRY_CODE, {
      session,
      waitUntil: (work) => after(() => work),
    });
    if (current.status !== "ok") return errorResponse("app_not_found", 404);

    const history = await loadPriceHistory(
      appid.data,
      DEFAULT_COUNTRY_CODE,
      current.data.price?.final ?? null,
    );

    return resultResponse(
      { status: "ok", data: history, meta: current.meta },
      "private, no-store",
    );
  } catch (err) {
    return failureResponse(err);
  }
}
