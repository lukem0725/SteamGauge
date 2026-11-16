/**
 * GET /api/deals
 *
 * Trending discounted games ranked by cost per hour (sale price divided by
 * completion time), cross-referenced with the signed-in user's unplayed
 * backlog. The work is in lib/deals.ts; every Steam read goes through the
 * cached-fetch pipeline.
 *
 * Requires a session: the ranking is the same for everyone, but the
 * "owned" flags and backlog warnings are personal.
 *
 * Requires Next.js 15.1 or later (`after`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { buildDeals } from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const result = await buildDeals(session, {
      // Keeps the function alive for stale-while-revalidate refreshes.
      waitUntil: (work) => after(() => work),
    });

    // Personalised: never stored by the CDN or a shared cache.
    return resultResponse(result, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}
