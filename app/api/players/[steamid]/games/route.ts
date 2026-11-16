/**
 * GET /api/players/[steamid]/games
 *
 * A player's library with playtime (architecture doc 4.2). Requires a
 * session. Any signed-in user may request any SteamID; Steam's own privacy
 * settings decide what comes back, and a private library is answered with
 * HTTP 200 and `status: "private"`.
 *
 * Requires Next.js 15.1 or later (`after`, async `params`).
 */
import { after, type NextRequest, type NextResponse } from "next/server";

import { errorResponse, failureResponse, resultResponse } from "@/lib/api/respond";
import { getSessionUser } from "@/lib/auth/session";
import { SESSION_COOKIE } from "@/lib/auth/shared";
import { getOwnedGames } from "@/lib/steam/endpoints";
import { steamIdSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ steamid: string }> },
): Promise<NextResponse> {
  try {
    const session = await getSessionUser(request.cookies.get(SESSION_COOKIE)?.value);
    if (!session) return errorResponse("auth_required", 401);

    const steamid = steamIdSchema.safeParse((await params).steamid);
    if (!steamid.success) return errorResponse("invalid_steamid", 400);

    const result = await getOwnedGames(steamid.data, {
      session,
      // Keeps the function alive for a stale-while-revalidate refresh.
      waitUntil: (work) => after(() => work),
    });

    // Per-user data: never stored by the CDN or a shared cache.
    return resultResponse(result, "private, no-store");
  } catch (err) {
    return failureResponse(err);
  }
}
