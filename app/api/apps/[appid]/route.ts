/**
 * GET /api/apps/[appid]
 *
 * Store page data for one app, including its current price (architecture doc
 * 4.2). No session required. The answer is the same for every user, so the
 * CDN may cache it and most requests never reach this function.
 *
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { getAppDetails } from "@/lib/steam/endpoints";
import { DEFAULT_COUNTRY_CODE, appIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CDN: fresh for 1 hour, then served stale for up to a day while it refetches. */
const PUBLIC_CACHE = "public, s-maxage=3600, stale-while-revalidate=86400";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appid: string }> },
): Promise<NextResponse> {
  try {
    const appid = appIdSchema.safeParse((await params).appid);
    if (!appid.success) return errorResponse("invalid_appid", 400);

    // Optional: a signed-in caller gets the higher quota tier on a cache miss.
    // The response body is identical either way, so it stays CDN-cacheable.
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);

    const result = await getAppDetails(appid.data, DEFAULT_COUNTRY_CODE, {
      session,
      waitUntil: (work) => after(() => work),
    });

    // "not_found" is cached too, but briefly, in case the app appears later.
    return resultResponse(result, result.status === "ok" ? PUBLIC_CACHE : "public, s-maxage=300");
  } catch (err) {
    return failureResponse(err);
  }
}
