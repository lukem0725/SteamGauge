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

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
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

    const result = await buildGameInsights(appid.data, modeParam, {
      session,
      waitUntil: (work) => after(() => work),
    });
    return resultResponse(result, "private, max-age=60");
  } catch (err) {
    return failureResponse(err);
  }
}
