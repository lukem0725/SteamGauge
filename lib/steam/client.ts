/**
 * lib/steam/client.ts
 *
 * The isolated upstream client. This is the ONLY module that reads
 * STEAM_API_KEY and the ONLY module that calls the Steam Web API or the
 * Storefront API. (Sign-in verification against Steam's OpenID endpoint uses
 * no key and lives in app/api/auth/steam/callback/route.ts.)
 *
 * Guarantees:
 *   - Fixed hosts and a fixed allowlist of methods. No caller-supplied value
 *     ever becomes part of a hostname or path, so there is no SSRF surface.
 *   - The API key is added here and nowhere else. It never appears in a
 *     thrown error, a log line, or a return value.
 *   - Every attempt, including each retry, must first be approved by the
 *     caller's `acquire` callback. That callback is where take_quota() is
 *     called, which keeps the quota governor impossible to bypass.
 *   - 5 second timeout, redirects refused, response size capped, at most
 *     2 retries (5xx, timeout, network failure only).
 *
 * This module does no caching and no database access. Callers go through
 * lib/steam/cached-fetch.ts, which wraps it with the cache/lease/quota
 * pipeline. Responses are returned as `unknown`: validate them with zod
 * (lib/steam/endpoints.ts) before use or caching.
 *
 * Required environment variable:
 *   STEAM_API_KEY   32 hex characters. Never prefixed NEXT_PUBLIC_.
 */
import "server-only";

import type { SteamUpstream } from "./ttl";

// -----------------------------------------------------------------------------
// Fixed upstreams and method allowlist
// -----------------------------------------------------------------------------

const WEB_API_ORIGIN = "https://api.steampowered.com";
const STORE_ORIGIN = "https://store.steampowered.com";

/** Steam Web API methods SteamGauge is allowed to call (architecture doc 4.2). */
const WEB_API_METHODS = {
  GetPlayerSummaries: "/ISteamUser/GetPlayerSummaries/v2/",
  GetFriendList: "/ISteamUser/GetFriendList/v1/",
  ResolveVanityURL: "/ISteamUser/ResolveVanityURL/v1/",
  GetOwnedGames: "/IPlayerService/GetOwnedGames/v1/",
  GetRecentlyPlayedGames: "/IPlayerService/GetRecentlyPlayedGames/v1/",
  GetPlayerAchievements: "/ISteamUserStats/GetPlayerAchievements/v1/",
  GetSchemaForGame: "/ISteamUserStats/GetSchemaForGame/v2/",
  GetNewsForApp: "/ISteamNews/GetNewsForApp/v2/",
  /** Public wishlist: appid, priority, date_added only. Keyless on Steam's side. */
  GetWishlist: "/IWishlistService/GetWishlist/v1/",
  /** Store data for up to 50 apps per call: name, assets, release, reviews, price. */
  GetItems: "/IStoreBrowseService/GetItems/v1/",
  /**
   * Review summary for one app. Replaced store.steampowered.com/appreviews,
   * which Valve retired on 2026-10-22. Keyless: see KEYLESS_METHODS.
   */
  GetAppReviews: "/IUserReviewsService/GetAppReviews/v1/",
  /**
   * Steam's own store query: the source of the deals pool (discounted apps
   * among the global top sellers), with store data for each app.
   */
  StoreQuery: "/IStoreQueryService/Query/v1/",
  /** Live concurrent players for one app. */
  GetNumberOfCurrentPlayers: "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/",
  /** Every Steam store tag's id and name, to label the tag ids GetItems returns. */
  GetTagList: "/IStoreService/GetTagList/v1/",
} as const;

/**
 * Methods called WITHOUT our API key. Steam documents the key for
 * GetAppReviews as optional and meant for the app's own publisher, so sending
 * ours gains nothing and only exposes it in one more URL.
 */
const KEYLESS_METHODS: ReadonlySet<string> = new Set(["GetAppReviews"]);

/** Storefront methods SteamGauge is allowed to call. Unauthenticated. */
const STORE_METHODS = {
  appdetails: "/api/appdetails",
  featuredcategories: "/api/featuredcategories",
} as const;

export type SteamWebApiMethod = keyof typeof WEB_API_METHODS;
export type SteamStoreMethod = keyof typeof STORE_METHODS;
export type SteamMethod = SteamWebApiMethod | SteamStoreMethod;

// -----------------------------------------------------------------------------
// Tunables (architecture doc 5.5 and 6.4)
// -----------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Parameter names callers may never set; the client owns them. */
const RESERVED_PARAMS = new Set(["key", "format"]);

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

export type SteamErrorKind =
  /** STEAM_API_KEY is missing or malformed. Deployment problem. */
  | "config"
  /** The caller passed a reserved or malformed parameter. Programming error. */
  | "bad_request"
  /** `acquire` returned false: budget spent or breaker open. Serve stale. */
  | "quota_denied"
  /** HTTP 429, or 403 from the Storefront. Open the circuit breaker. */
  | "throttled"
  /** Steam says the profile or data is not public. Cache as status "private". */
  | "private"
  /** Steam rejected our credentials. The API key is wrong or revoked. */
  | "forbidden"
  /** HTTP 404. Cache as status "not_found". */
  | "not_found"
  /** HTTP 5xx after all retries. */
  | "upstream_error"
  /** No response within the timeout, after all retries. */
  | "timeout"
  /** Connection failed or a redirect was refused, after all retries. */
  | "network"
  /** Body was too large, not JSON, or otherwise unusable. */
  | "invalid_response";

/**
 * The only error this module throws. Safe to log as-is: it carries the method
 * name and HTTP status, never a URL, a query string, the key, or a response body.
 */
export class SteamError extends Error {
  readonly kind: SteamErrorKind;
  readonly upstream: SteamUpstream;
  readonly method: string;
  readonly status?: number;
  /** Seconds Steam asked us to wait, when it said so. Usually absent. */
  readonly retryAfterSeconds?: number;

  constructor(
    kind: SteamErrorKind,
    upstream: SteamUpstream,
    method: string,
    detail: string,
    extra: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(`Steam ${upstream}/${method}: ${kind} (${detail})`);
    this.name = "SteamError";
    this.kind = kind;
    this.upstream = upstream;
    this.method = method;
    this.status = extra.status;
    this.retryAfterSeconds = extra.retryAfterSeconds;
  }

  /** True when the caller should open the circuit breaker for this upstream. */
  get shouldOpenBreaker(): boolean {
    return this.kind === "throttled";
  }

  /** True when the result is a valid negative answer that should be cached. */
  get isNegativeResult(): boolean {
    return this.kind === "private" || this.kind === "not_found";
  }
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export type SteamParams = Readonly<Record<string, string | number | boolean | undefined>>;

export interface AttemptContext {
  readonly upstream: SteamUpstream;
  /** A Steam method name, or an ITAD endpoint name when upstream is "itad". */
  readonly method: string;
  /** 1 for the first try, 2 and 3 for retries. */
  readonly attempt: number;
}

export interface SteamRequestOptions {
  /**
   * Called before EVERY attempt, retries included. Return true to allow the
   * network call, false to block it. Implement it with take_quota() and the
   * breaker check so each attempt is charged to the budget (doc 5.5).
   */
  readonly acquire: (ctx: AttemptContext) => Promise<boolean>;
  /** Optional caller cancellation, for example the incoming request's signal. */
  readonly signal?: AbortSignal;
}

/**
 * Calls an allowlisted Steam Web API method. Adds the API key.
 *
 * @returns the parsed JSON body, untyped. Validate before use.
 * @throws SteamError
 */
export function steamWebApi(
  method: SteamWebApiMethod,
  params: SteamParams,
  options: SteamRequestOptions,
): Promise<unknown> {
  const path = lookup(WEB_API_METHODS, method, "webapi");
  const url = buildUrl(WEB_API_ORIGIN, path, params, "webapi", method);
  // Steam accepts the key only as a query parameter. This is why URLs are
  // never logged or attached to errors anywhere in this file.
  if (!KEYLESS_METHODS.has(method)) url.searchParams.set("key", readApiKey(method));
  url.searchParams.set("format", "json");
  return execute("webapi", method, url, options);
}

/**
 * Calls an allowlisted Storefront method. No API key is sent.
 *
 * @returns the parsed JSON body, untyped. Validate before use.
 * @throws SteamError
 */
export function steamStore(
  method: SteamStoreMethod,
  params: SteamParams,
  options: SteamRequestOptions,
): Promise<unknown> {
  const path = lookup(STORE_METHODS, method, "store");
  const url = buildUrl(STORE_ORIGIN, path, params, "store", method);
  return execute("store", method, url, options);
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function readApiKey(method: string): string {
  const key = process.env.STEAM_API_KEY?.trim();
  if (!key) {
    throw new SteamError("config", "webapi", method, "STEAM_API_KEY is not set");
  }
  if (!/^[0-9A-Fa-f]{32}$/.test(key)) {
    throw new SteamError("config", "webapi", method, "STEAM_API_KEY is malformed");
  }
  return key;
}

/** Runtime allowlist check. Types alone do not protect against untyped callers. */
function lookup(
  table: Readonly<Record<string, string>>,
  method: string,
  upstream: SteamUpstream,
): string {
  // hasOwnProperty guards against inherited names such as "constructor".
  const path = Object.prototype.hasOwnProperty.call(table, method) ? table[method] : undefined;
  if (path === undefined) {
    throw new SteamError("bad_request", upstream, "unknown", "method is not allowlisted");
  }
  return path;
}

function buildUrl(
  origin: string,
  path: string,
  params: SteamParams,
  upstream: SteamUpstream,
  method: string,
): URL {
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (RESERVED_PARAMS.has(name.toLowerCase())) {
      throw new SteamError("bad_request", upstream, method, `parameter "${name}" is reserved`);
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\[\d+\])?$/.test(name)) {
      throw new SteamError("bad_request", upstream, method, "invalid parameter name");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new SteamError("bad_request", upstream, method, `parameter "${name}" is not finite`);
    }
    // Steam expects 1/0 for booleans. URLSearchParams percent-encodes values.
    url.searchParams.set(name, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  return url;
}

async function execute(
  upstream: SteamUpstream,
  method: SteamMethod,
  url: URL,
  options: SteamRequestOptions,
): Promise<unknown> {
  let lastError: SteamError | undefined;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (options.signal?.aborted) {
      throw new SteamError("network", upstream, method, "cancelled by caller");
    }

    if (attempt > 1) {
      await sleep(backoffDelayMs(attempt), options.signal);
    }

    // Quota gate. A thrown error here is treated as a denial: if we cannot
    // prove the budget allows the call, we do not make it.
    let allowed: boolean;
    try {
      allowed = await options.acquire({ upstream, method, attempt });
    } catch {
      allowed = false;
    }
    if (!allowed) {
      throw new SteamError("quota_denied", upstream, method, `attempt ${attempt} not permitted`);
    }

    try {
      return await attemptOnce(upstream, method, url, options.signal);
    } catch (err) {
      const steamErr = toSteamError(err, upstream, method);
      if (!isRetryable(steamErr)) throw steamErr;
      lastError = steamErr;
    }
  }

  throw lastError ?? new SteamError("upstream_error", upstream, method, "retries exhausted");
}

function isRetryable(err: SteamError): boolean {
  return err.kind === "upstream_error" || err.kind === "timeout" || err.kind === "network";
}

async function attemptOnce(
  upstream: SteamUpstream,
  method: SteamMethod,
  url: URL,
  callerSignal: AbortSignal | undefined,
): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error", // a redirect could carry the key to another host
      cache: "no-store", // api_cache is the cache; never Next.js's fetch cache
      credentials: "omit",
      signal,
    });
  } catch {
    // The original error is dropped on purpose: its message or cause can
    // contain the full URL, which includes the API key.
    if (timeout.aborted) {
      throw new SteamError("timeout", upstream, method, `no response in ${REQUEST_TIMEOUT_MS} ms`);
    }
    if (callerSignal?.aborted) {
      throw new SteamError("network", upstream, method, "cancelled by caller");
    }
    throw new SteamError("network", upstream, method, "connection failed or redirect refused");
  }

  if (!response.ok) {
    throw await classifyHttpError(response, upstream, method);
  }

  const text = await readBodyCapped(response, upstream, method, timeout);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SteamError("invalid_response", upstream, method, "body is not valid JSON", {
      status: response.status,
    });
  }
}

/**
 * Maps a non-2xx response to an error kind.
 *
 * 401/403 need care because Steam uses them for two different things:
 *   - Web API, JSON body:      the profile or its game details are not public.
 *   - Web API, non-JSON body:  the API key was rejected.
 *   - Storefront 403:          IP-level throttling.
 * Verify this mapping against real responses during development.
 */
async function classifyHttpError(
  response: Response,
  upstream: SteamUpstream,
  method: SteamMethod,
): Promise<SteamError> {
  const status = response.status;
  const isJson = (response.headers.get("content-type") ?? "").includes("json");
  const extra = { status, retryAfterSeconds: parseRetryAfter(response.headers.get("retry-after")) };

  // Release the socket without waiting on it: a cancel that never settles
  // must not stall the request. The body is never read into an error or a log.
  void response.body?.cancel().catch(() => undefined);

  if (status === 429) {
    return new SteamError("throttled", upstream, method, "HTTP 429", extra);
  }
  if (status === 401 || status === 403) {
    if (upstream === "store") {
      return new SteamError("throttled", upstream, method, `HTTP ${status}`, extra);
    }
    return isJson
      ? new SteamError("private", upstream, method, `HTTP ${status}`, extra)
      : new SteamError("forbidden", upstream, method, `HTTP ${status}, check STEAM_API_KEY`, extra);
  }
  if (status === 404) {
    return new SteamError("not_found", upstream, method, "HTTP 404", extra);
  }
  if (status >= 500) {
    return new SteamError("upstream_error", upstream, method, `HTTP ${status}`, extra);
  }
  return new SteamError("bad_request", upstream, method, `HTTP ${status}`, extra);
}

async function readBodyCapped(
  response: Response,
  upstream: SteamUpstream,
  method: SteamMethod,
  timeout: AbortSignal,
): Promise<string> {
  const tooLarge = () =>
    new SteamError("invalid_response", upstream, method, "response exceeds size limit", {
      status: response.status,
    });

  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let received = 0;
  let text = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    if (err instanceof SteamError) throw err;
    throw timeout.aborted
      ? new SteamError("timeout", upstream, method, "body not received in time")
      : new SteamError("network", upstream, method, "connection lost while reading body");
  }
}

function toSteamError(err: unknown, upstream: SteamUpstream, method: string): SteamError {
  return err instanceof SteamError
    ? err
    : new SteamError("network", upstream, method, "unexpected failure");
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Exponential backoff with full jitter: up to 250 ms, then up to 500 ms. */
function backoffDelayMs(attempt: number): number {
  const ceiling = RETRY_BASE_DELAY_MS * 2 ** (attempt - 2);
  return Math.floor(Math.random() * ceiling);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
