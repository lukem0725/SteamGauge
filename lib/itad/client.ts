/**
 * lib/itad/client.ts
 *
 * The isolated client for the IsThereAnyDeal (ITAD) API, used for what Steam
 * does not publish: historical low prices, current prices at other stores,
 * and multi-year price history.
 *
 * Same guarantees as lib/steam/client.ts:
 *   - One fixed host and a fixed allowlist of endpoints. No caller value ever
 *     becomes part of a host or path.
 *   - The API key travels in the `ITAD-API-Key` header, never in a URL, and
 *     never appears in an error or a log line.
 *   - The caller's `acquire` callback must approve every attempt, retries
 *     included. lib/steam/cached-fetch.ts implements it with take_quota()
 *     against the "itad" bucket, so the 1,000 requests per 5 minutes ITAD
 *     allows is never exceeded.
 *   - 5 second timeout, redirects refused, 5 MB response cap, at most 2
 *     retries (5xx, timeout, network failure only).
 *
 * Failures are thrown as SteamError with upstream "itad", so the cache
 * engine's breaker, retry and error mapping apply unchanged.
 *
 * VERIFY BEFORE LAUNCH: ITAD's documentation page lists endpoint titles and
 * parameters but did not show literal paths when this was written. The paths
 * in ENDPOINTS follow ITAD's published v2 naming; confirm each against
 * https://docs.isthereanydeal.com/ with one real request.
 *
 * Required environment variable:
 *   ITAD_API_KEY   from https://isthereanydeal.com/apps/my/ (server only)
 */
import "server-only";

import { SteamError, type AttemptContext } from "@/lib/steam/client";

const ITAD_ORIGIN = "https://api.isthereanydeal.com";

/** ITAD's id for the Steam store. */
export const ITAD_STEAM_SHOP_ID = 61;

const ENDPOINTS = {
  // ITAD's deals list is deliberately not used: the deals pool comes from
  // Steam, and ITAD is only asked about apps by their Steam AppID.
  /** Steam ids ("app/620") to ITAD game ids. Body: string[]. */
  idsBySteamId: { httpMethod: "POST", path: `/lookup/id/shop/${ITAD_STEAM_SHOP_ID}/v1` },
  /** Current prices at every store and historical lows for many games. Body: ITAD ids. */
  prices: { httpMethod: "POST", path: "/games/prices/v3" },
  /**
   * Log of price changes for one game. Query: id, country, shops, since.
   * Pass `since` explicitly: without it the log covered only recent months.
   */
  history: { httpMethod: "GET", path: "/games/history/v2" },
} as const;

export type ItadEndpoint = keyof typeof ENDPOINTS;

export interface ItadRequest {
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** JSON body for POST endpoints. */
  readonly body?: unknown;
}

export interface ItadRequestOptions {
  readonly acquire: (ctx: AttemptContext) => Promise<boolean>;
  readonly signal?: AbortSignal;
}

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_BYTES = 64 * 1024;

/** True when an ITAD key is configured. Features fall back when it is not. */
export function isItadConfigured(): boolean {
  return readKey() !== null;
}

function readKey(): string | null {
  const key = process.env.ITAD_API_KEY?.trim();
  return key && /^[A-Za-z0-9_-]{16,128}$/.test(key) ? key : null;
}

/**
 * Calls one allowlisted ITAD endpoint.
 *
 * @returns the parsed JSON body, untyped. Validate before use.
 * @throws SteamError with upstream "itad".
 */
export async function itadRequest(
  endpoint: ItadEndpoint,
  request: ItadRequest,
  options: ItadRequestOptions,
): Promise<unknown> {
  if (!Object.prototype.hasOwnProperty.call(ENDPOINTS, endpoint)) {
    throw new SteamError("bad_request", "itad", "unknown", "endpoint is not allowlisted");
  }
  const { httpMethod, path } = ENDPOINTS[endpoint];

  const key = readKey();
  if (!key) throw new SteamError("config", "itad", endpoint, "ITAD_API_KEY is not set or malformed");

  const url = new URL(path, ITAD_ORIGIN);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.toLowerCase() === "key") {
      throw new SteamError("bad_request", "itad", endpoint, "invalid parameter name");
    }
    url.searchParams.set(name, String(value));
  }

  let body: string | undefined;
  if (httpMethod === "POST") {
    body = JSON.stringify(request.body ?? []);
    if (body.length > MAX_BODY_BYTES) {
      throw new SteamError("bad_request", "itad", endpoint, "request body too large");
    }
  }

  let lastError: SteamError | undefined;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new SteamError("network", "itad", endpoint, "cancelled by caller");
    }
    if (attempt > 1) await sleep(Math.floor(Math.random() * RETRY_BASE_DELAY_MS * 2 ** (attempt - 2)));

    let allowed: boolean;
    try {
      allowed = await options.acquire({ upstream: "itad", method: endpoint, attempt });
    } catch {
      allowed = false;
    }
    if (!allowed) throw new SteamError("quota_denied", "itad", endpoint, `attempt ${attempt} not permitted`);

    try {
      return await attemptOnce(endpoint, httpMethod, url, body, key, options.signal);
    } catch (err) {
      const steamErr =
        err instanceof SteamError
          ? err
          : new SteamError("network", "itad", endpoint, "unexpected failure");
      const retryable =
        steamErr.kind === "upstream_error" || steamErr.kind === "timeout" || steamErr.kind === "network";
      if (!retryable) throw steamErr;
      lastError = steamErr;
    }
  }
  throw lastError ?? new SteamError("upstream_error", "itad", endpoint, "retries exhausted");
}

async function attemptOnce(
  endpoint: ItadEndpoint,
  httpMethod: "GET" | "POST",
  url: URL,
  body: string | undefined,
  key: string,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: httpMethod,
      headers: {
        Accept: "application/json",
        "ITAD-API-Key": key,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body,
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal,
    });
  } catch {
    // The original error is dropped: nothing from the exchange is logged.
    if (timeout.aborted) throw new SteamError("timeout", "itad", endpoint, "no response in time");
    throw new SteamError("network", "itad", endpoint, "connection failed or redirect refused");
  }

  if (!response.ok) {
    const status = response.status;
    const retryAfter = Number(response.headers.get("retry-after"));
    const extra = {
      status,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter) : undefined,
    };
    void response.body?.cancel().catch(() => undefined);
    if (status === 429) throw new SteamError("throttled", "itad", endpoint, "HTTP 429", extra);
    if (status === 401 || status === 403) {
      throw new SteamError("forbidden", "itad", endpoint, `HTTP ${status}, check ITAD_API_KEY`, extra);
    }
    if (status === 404) throw new SteamError("not_found", "itad", endpoint, "HTTP 404", extra);
    if (status >= 500) throw new SteamError("upstream_error", "itad", endpoint, `HTTP ${status}`, extra);
    throw new SteamError("bad_request", "itad", endpoint, `HTTP ${status}`, extra);
  }

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw new SteamError("invalid_response", "itad", endpoint, "response exceeds size limit");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new SteamError("invalid_response", "itad", endpoint, "response exceeds size limit");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SteamError("invalid_response", "itad", endpoint, "body is not valid JSON");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
