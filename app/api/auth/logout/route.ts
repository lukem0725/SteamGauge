/**
 * POST /api/auth/logout
 *
 * Ends the session: deletes its row from `sessions`, clears the
 * `__Host-session` cookie, and sends the browser to the home view, /deals (v1.14).
 *
 * POST only, and only from our own origin, so another site cannot sign a
 * user out by linking or posting here. Called by the plain HTML form in the
 * navigation, so it works without JavaScript.
 */
import { NextResponse, type NextRequest } from "next/server";

import { rejectCrossOrigin } from "@/lib/api/respond";
import {
  SESSION_COOKIE,
  SIGNED_OUT_PATH,
  authCookieOptions,
  errorName,
  getAppOrigin,
  logAuthFailure,
  sha256Hex,
} from "@/lib/auth/shared";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 32 random bytes in base64url, as issued by the sign-in callback. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token && TOKEN_PATTERN.test(token)) {
    try {
      const { error } = await getSupabaseAdmin()
        .from("sessions")
        .delete()
        .eq("token_hash", sha256Hex(token));
      if (error) logAuthFailure("logout", "session_delete_failed", { dbCode: error.code });
    } catch (err) {
      // The cookie is still cleared below, so this browser is signed out
      // either way. The orphaned row expires with the session lifetime.
      logAuthFailure("logout", "session_delete_failed", { errorName: errorName(err) });
    }
  }

  const response = NextResponse.redirect(new URL(SIGNED_OUT_PATH, getAppOrigin()), 303);
  response.cookies.set(SESSION_COOKIE, "", authCookieOptions(0));
  response.headers.set("Cache-Control", "no-store");
  return response;
}
