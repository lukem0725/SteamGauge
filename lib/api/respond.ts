/**
 * lib/api/respond.ts
 *
 * Response helpers shared by the data Route Handlers, so every endpoint
 * speaks the same envelope (architecture doc 4.2):
 *
 *   success  { status: "ok" | "private" | "not_found", data, meta: { source, fetchedAt, stale } }
 *   failure  { error: "<code>" }  with a matching HTTP status and, where
 *            useful, a Retry-After header
 *
 * "private" and "not_found" are HTTP 200: they are valid, cacheable answers
 * about the data, not failures of the request.
 */
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

import { getAppOrigin } from "@/lib/auth/shared";
import { CachedFetchError, type CachedResult } from "@/lib/steam/cached-fetch";

/** Sends a `cachedFetch` result. It already has the envelope's shape. */
export function resultResponse<T>(result: CachedResult<T>, cacheControl: string): NextResponse {
  return NextResponse.json(result, { headers: { "Cache-Control": cacheControl } });
}

/** Sends `{ error: code }` with no caching. */
export function errorResponse(
  code: string,
  status: number,
  retryAfterSeconds?: number,
): NextResponse {
  const response = NextResponse.json({ error: code }, { status });
  response.headers.set("Cache-Control", "no-store");
  if (retryAfterSeconds !== undefined) {
    response.headers.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterSeconds))));
  }
  return response;
}

/**
 * Maps anything thrown inside a data route to a response. Only fixed codes
 * reach the browser; unexpected errors are logged by class name alone.
 */
export function failureResponse(err: unknown): NextResponse {
  if (err instanceof CachedFetchError) {
    return errorResponse(err.reason, err.httpStatus, err.retryAfterSeconds);
  }
  console.error(
    JSON.stringify({
      scope: "api",
      event: "unhandled_error",
      errorName: err instanceof Error ? err.name : "NonError",
    }),
  );
  return errorResponse("internal", 500);
}

// -----------------------------------------------------------------------------
// State-changing requests (POST, DELETE)
// -----------------------------------------------------------------------------

/**
 * CSRF guard for state-changing routes (architecture doc 6.4). Browsers send
 * an `Origin` header on every cross-site POST/DELETE and on same-origin
 * `fetch` ones; it must be exactly our own origin. Together with the
 * SameSite=Lax session cookie this stops another site from acting as the user.
 *
 * @returns a 403 response to send, or null if the request may proceed.
 */
export function rejectCrossOrigin(request: NextRequest): NextResponse | null {
  return request.headers.get("origin") === getAppOrigin()
    ? null
    : errorResponse("bad_origin", 403);
}

/**
 * Reads a small JSON body. Returns undefined if it is missing, too large, not
 * declared as JSON, or not valid JSON; the caller answers 400.
 */
export async function readJsonBody(request: NextRequest, maxBytes = 2_048): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) return undefined;
  try {
    const text = await request.text();
    if (text.length === 0 || text.length > maxBytes) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
