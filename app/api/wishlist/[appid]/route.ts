/**
 * DELETE /api/wishlist/[appid]
 *
 * Stops tracking an app for the signed-in user. Answers 204 whether or not
 * the app was on the list, so a repeated request is harmless.
 */
import { NextResponse, type NextRequest } from "next/server";

import { errorResponse, failureResponse, rejectCrossOrigin } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { appIdSchema } from "@/lib/validation";
import { removeFromWishlist } from "@/lib/wishlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appid: string }> },
): Promise<NextResponse> {
  try {
    const crossOrigin = rejectCrossOrigin(request);
    if (crossOrigin) return crossOrigin;

    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const appid = appIdSchema.safeParse((await params).appid);
    if (!appid.success) return errorResponse("invalid_appid", 400);

    await removeFromWishlist(session, appid.data);

    return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return failureResponse(err);
  }
}
