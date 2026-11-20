/**
 * GET /api/deals
 *
 * Every discounted game among Steam's global top 1,000 sellers, from
 * Steam's own store query (IStoreQueryService/Query, 5 cached pages of 200),
 * with Steam's price, discount, sale end, release date and review totals.
 * IsThereAnyDeal adds, by Steam AppID, the historical lows behind the price
 * badges and the cheapest current price at another store. The work is in
 * lib/deals.ts; every Steam and ITAD read goes through the cached-fetch
 * pipeline. Rows are ranked in the browser by log10(reviews) x discount %.
 *
 * Review totals missing from Steam's batched store data are filled in from a
 * shared per-app cache plus at most 30 GetAppReviews lookups per request
 * (lib/steam/review-backfill.ts). The response waits at most about 2.5 s for
 * those; lookups still running finish after it via `after`.
 *
 * Public since v1.13 (lib/api/access.ts). The deal list is the same for
 * everyone; with a session each row also carries the personal owned /
 * wished / watched flags, and without one `personal` is false and the flags
 * are empty. Signed-out visitors are limited per IP. Either way the answer
 * is never stored by a shared cache: one URL serves both kinds.
 *
 * Requires Next.js 15.1 or later (`after`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { takeVisitorQuota } from "@/lib/api/visitor-limit";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { buildDeals } from "@/lib/deals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Room for background review lookups to finish after the response (seconds). */
export const maxDuration = 30;
/** Deals loads per IP per minute for signed-out visitors (v1.13); signed-in users are not limited here. */
const DEALS_LIMIT = { signedIn: 0, anonymous: 20 } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session && !(await takeVisitorQuota(request, null, "deals", DEALS_LIMIT))) {
      return errorResponse("rate_limited", 429, 30);
    }

    const result = await buildDeals(session, {
      // Keeps the function alive for stale-while-revalidate refreshes.
      waitUntil: (work) => after(() => work),
    });

    // Personalised when signed in, and the same URL either way: never stored
    // by the CDN or a shared cache.
    return resultResponse(result, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}
