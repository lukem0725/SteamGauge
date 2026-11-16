/**
 * /api/wishlist
 *
 *   GET   The signed-in user's tracked apps with current prices.
 *   POST  Track an app. Body: { "appid": 730, "note": "optional" }.
 *         Tracking an app twice is safe and updates the note.
 *
 * The list is always the session user's own. No SteamID is accepted from the
 * URL or body, so there is no way to address another user's list.
 *
 * Removal and price history live under /api/wishlist/[appid].
 * Requires Next.js 15.1 or later (`after`).
 */
import { NextResponse, after, type NextRequest } from "next/server";

import {
  errorResponse,
  failureResponse,
  readJsonBody,
  rejectCrossOrigin,
  resultResponse,
} from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { addToWishlistSchema } from "@/lib/validation";
import { addToWishlist, listWishlist } from "@/lib/wishlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const result = await listWishlist(session, { waitUntil: (work) => after(() => work) });
    return resultResponse(result, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;

    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const input = addToWishlistSchema.safeParse(await readJsonBody(request));
    if (!input.success) return errorResponse("invalid_body", 400);

    const result = await addToWishlist(session, input.data, {
      waitUntil: (work) => after(() => work),
    });

    if (result.kind === "app_not_found") return errorResponse("app_not_found", 404);
    if (result.kind === "wishlist_full") return errorResponse("wishlist_full", 409);

    const response = NextResponse.json({ appid: result.appid }, { status: 201 });
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (err) {
    return failureResponse(err);
  }
}
