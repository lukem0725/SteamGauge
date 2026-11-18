/**
 * lib/api/client.ts
 *
 * Browser-side client for our own JSON API, used with TanStack Query.
 * Understands the response envelope from architecture doc 4.2:
 *
 *   success  { status, data, meta }      returned as-is
 *   failure  { error: "<code>" }         thrown as ApiError
 *
 * Only a type is imported from the server-side cache module, and type
 * imports are erased at build time.
 */
import type { CachedResult } from "@/lib/steam/cached-fetch";

/** A non-2xx answer from our API: `{ error: code }` plus the HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, code: string, retryAfterSeconds: number | null) {
    super(`API ${status}: ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export async function apiGet<T>(
  path: string,
  signal: AbortSignal,
  /** Extra request headers, e.g. the prefetch marker (lib/prefetch-header.ts). */
  extraHeaders?: Readonly<Record<string, string>>,
): Promise<CachedResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      signal,
      credentials: "same-origin",
      headers: { ...extraHeaders, Accept: "application/json" },
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ApiError(0, "network", null);
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Not JSON (for example a platform error page). Handled below.
  }

  if (!response.ok) {
    const code =
      typeof (body as { error?: unknown } | null)?.error === "string"
        ? (body as { error: string }).error
        : "unknown";
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(
      response.status,
      code,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }

  if (!isEnvelope(body)) throw new ApiError(response.status, "bad_envelope", null);
  return body as CachedResult<T>;
}

/** Checks the response envelope from architecture doc 4.2. */
export function isEnvelope(value: unknown): value is CachedResult<unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { status?: unknown; meta?: { source?: unknown; fetchedAt?: unknown } };
  return (
    (v.status === "ok" || v.status === "private" || v.status === "not_found") &&
    typeof v.meta === "object" &&
    v.meta !== null &&
    (v.meta.source === "cache" || v.meta.source === "steam") &&
    typeof v.meta.fetchedAt === "string"
  );
}

/** Retry only what waiting can fix: Steam busy, quota windows, flaky network. */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (!(error instanceof ApiError)) return false;
  const transient = error.status === 0 || error.status === 503;
  return transient && failureCount < 2;
}

export function retryDelay(attempt: number, error: Error): number {
  const hinted = error instanceof ApiError ? error.retryAfterSeconds : null;
  return Math.min((hinted ?? 2 ** attempt) * 1000, 8_000);
}

/**
 * Sends a state-changing request (POST, DELETE) with an optional JSON body.
 * Resolves with the parsed JSON response, or null for an empty one (204).
 *
 * @throws ApiError on a non-2xx answer or a network failure.
 */
export async function apiSend(
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", null);
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // Empty (204) or non-JSON body.
  }

  if (!response.ok) {
    const code =
      typeof (parsed as { error?: unknown } | null)?.error === "string"
        ? (parsed as { error: string }).error
        : "unknown";
    const retryAfter = Number(response.headers.get("Retry-After"));
    throw new ApiError(
      response.status,
      code,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    );
  }
  return parsed;
}
