/**
 * lib/steam/cached-fetch.ts
 *
 * The data engine. Every read of Steam data in SteamGauge goes through
 * `cachedFetch`, which implements the cache-first read path of architecture
 * doc 5.2 on top of the quota governor of 5.5 and the tables of 5.6.
 *
 *   fresh    Serve the api_cache row. No Steam call, one database read.
 *   stale    Serve the row now, refresh it in the background.
 *   miss     Refresh while the caller waits.
 *
 * A refresh, blocking or background, always runs the same three guarded steps:
 *
 *   1. Lease   One instance at a time may refresh a key (stampede guard).
 *   2. Quota   Circuit breaker, then take_quota(), before every attempt.
 *   3. Fetch   Call Steam, validate, write the row with new lifetimes.
 *
 * Built only on lib/steam/client.ts, lib/steam/ttl.ts and
 * lib/supabase/server.ts. It imports no validation library: the caller passes
 * a `validate` function (lib/steam/endpoints.ts supplies zod-backed ones).
 */
import "server-only";

import { itadRequest, type ItadEndpoint, type ItadRequest } from "@/lib/itad/client";
import { getSupabaseAdmin } from "@/lib/supabase/server";

import {
  SteamError,
  steamStore,
  steamWebApi,
  type AttemptContext,
  type SteamParams,
  type SteamStoreMethod,
  type SteamWebApiMethod,
} from "./client";
import {
  fetchDealsFallback,
  fetchSalePage,
  fetchItadAppPrices,
  fetchItadHistory,
  fetchSteamWishlistIds,
  fetchWishlistView,
} from "./composites";
import { storeMetaInput } from "./insights";
import {
  REFRESH_LEASE_SECONDS,
  TTL,
  cacheKey,
  classifyFreshness,
  computeExpiry,
  type CacheStatus,
  type SteamResource,
  type SteamUpstream,
  type TtlPolicy,
} from "./ttl";

// =============================================================================
// Public types
// =============================================================================

/** The arguments that identify one cache entry, as taken by `cacheKey[R]`. */
export type KeyArgs<R extends SteamResource> = Parameters<(typeof cacheKey)[R]>;

/**
 * What a validator returns for a raw Steam response.
 *
 * Steam often reports "private" or "no such app" inside an HTTP 200 body
 * (an empty `response` object, or `success: false`). The validator is where
 * that is recognised. Throw for anything malformed: it will not be cached.
 */
export type Validated<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "private" | "not_found" };

export interface CachedFetchOptions<R extends SteamResource, T> {
  /** Which row of the TTL table (doc 5.3) this read belongs to. */
  readonly resource: R;
  /** Already-validated identifiers, e.g. [steamid] or [appid, cc]. */
  readonly keyArgs: KeyArgs<R>;
  /**
   * Checks and normalises Steam's raw JSON. Its `data` is what gets stored in
   * api_cache.payload and returned to callers, so it must be JSON-serialisable.
   */
  readonly validate: (raw: unknown) => Validated<T>;
  /**
   * The verified session, if any. Player-scoped resources require one.
   * Signed-in users also get the highest quota tier on a cache miss.
   */
  readonly session?: { readonly steamid: string } | null;
  /** "cron" marks warm-up jobs: lowest quota tier. Default "interactive". */
  readonly priority?: "interactive" | "cron";
  /**
   * Keeps the serverless function alive until a background refresh finishes.
   * In a Route Handler pass Next.js's `after`:
   *
   *     import { after } from "next/server";
   *     cachedFetch({ ..., waitUntil: (work) => after(() => work) });
   *
   * Without it the refresh still starts, but a serverless platform may freeze
   * the function as soon as the response is sent and the refresh is lost.
   */
  readonly waitUntil?: (work: Promise<void>) => void;
  /**
   * Runs after a successful fetch from Steam (never on a cache hit). Used for
   * side effects such as upserting steam_apps from app details. A failure here
   * is logged and does not fail the read.
   */
  readonly onRefreshed?: (data: T) => Promise<void>;
}

export interface CacheMeta {
  readonly source: "cache" | "steam";
  /** ISO-8601 time the data was fetched from Steam. */
  readonly fetchedAt: string;
  /** True when the data is past its fresh lifetime and a refresh was started. */
  readonly stale: boolean;
}

/** Matches the response envelope in doc 4.2. */
export type CachedResult<T> =
  | { readonly status: "ok"; readonly data: T; readonly meta: CacheMeta }
  | { readonly status: "private" | "not_found"; readonly data: null; readonly meta: CacheMeta };

export type CachedFetchFailure =
  /** A player resource was requested without a session. HTTP 401. */
  | "auth_required"
  /** Our own budget for this upstream is spent. HTTP 503. */
  | "quota_exhausted"
  /** Steam is throttling us; the circuit breaker is open. HTTP 503. */
  | "throttled"
  /** Steam timed out, errored, or was unreachable. HTTP 503. */
  | "upstream_unavailable"
  /** Steam answered with something the validator rejected. HTTP 502. */
  | "invalid_response"
  /** Another instance is fetching this key and did not finish in time. HTTP 503. */
  | "busy"
  /** Supabase could not be read. HTTP 503. */
  | "storage_unavailable"
  /** Misconfiguration or a programming error (bad key, bad parameter). HTTP 500. */
  | "internal";

/**
 * Thrown only when there is no cached value to serve. Route handlers map it
 * to `httpStatus` and, when present, a Retry-After header. The message is
 * safe to log and contains no key, URL, SteamID, or response body.
 */
export class CachedFetchError extends Error {
  readonly reason: CachedFetchFailure;
  readonly resource: SteamResource;
  readonly httpStatus: 401 | 500 | 502 | 503;
  readonly retryAfterSeconds?: number;

  constructor(reason: CachedFetchFailure, resource: SteamResource, retryAfterSeconds?: number) {
    super(`cachedFetch(${resource}) failed: ${reason}`);
    this.name = "CachedFetchError";
    this.reason = reason;
    this.resource = resource;
    this.retryAfterSeconds = retryAfterSeconds;
    this.httpStatus =
      reason === "auth_required" ? 401
      : reason === "internal" ? 500
      : reason === "invalid_response" ? 502
      : 503;
  }
}

// =============================================================================
// Budgets (doc 5.5)
// =============================================================================

/** Ceiling on today's Web API usage, by who is asking. Lower tiers stop first. */
const WEBAPI_DAY_CEILING = {
  /** Cron warming and stale-while-revalidate refreshes: 70%. */
  background: 56_000,
  /** Cache miss, no session: 90%. */
  anonymous: 72_000,
  /** Cache miss, signed-in user: 100% of our self-imposed limit. */
  signedIn: 80_000,
} as const;
const WEBAPI_MINUTE_CEILING = 120;
const STORE_FIVE_MINUTE_CEILING = 150;
/**
 * IsThereAnyDeal allows 1,000 requests per 5 minutes per key. Background
 * refreshes stop at 450 so people using the app always have room.
 */
const ITAD_FIVE_MINUTE_CEILING = { background: 450, interactive: 600 } as const;

type QuotaTier = keyof typeof WEBAPI_DAY_CEILING;

/** Breaker: 60 s on the first trip, doubling to a 15-minute maximum. */
const BREAKER_BASE_SECONDS = 60;
const BREAKER_MAX_SECONDS = 15 * 60;
const BREAKER_MAX_LEVEL = 5;
/** A new trip within this long of the last one closing escalates the level. */
const BREAKER_ESCALATION_WINDOW_SECONDS = 10 * 60;

// =============================================================================
// Engine tunables
// =============================================================================

const EPOCH = new Date(0).toISOString();

/** A refresh must finish inside its lease, so it is cut off 3 s before. */
const REFRESH_DEADLINE_MS = (REFRESH_LEASE_SECONDS - 3) * 1000;

/** When another instance holds the lease on a missing key, wait this long. */
const POLL_INTERVAL_MS = 500;
const POLL_ATTEMPTS = 6;

/**
 * Stale-if-error (doc 5.2). When a background refresh fails, a row about to
 * expire is kept servable for one more hour, up to 24 hours past its normal
 * stale lifetime in total.
 */
const STALE_IF_ERROR_GRACE_MS = 60 * 60 * 1000;
const STALE_IF_ERROR_MAX_EXTRA_MS = 24 * 60 * 60 * 1000;

const PG_UNIQUE_VIOLATION = "23505";

// =============================================================================
// Resource -> Steam request
// =============================================================================

/**
 * Upstream calls available to a composite refresh. Each one goes through the
 * same quota gate, breaker and timeout as a single-call refresh.
 */
export interface UpstreamIO {
  webApi(method: SteamWebApiMethod, params: SteamParams): Promise<unknown>;
  store(method: SteamStoreMethod, params: SteamParams): Promise<unknown>;
  itad(endpoint: ItadEndpoint, request: ItadRequest): Promise<unknown>;
}

type RequestPlan =
  | { readonly upstream: "webapi"; readonly method: SteamWebApiMethod; readonly params: SteamParams }
  | { readonly upstream: "store"; readonly method: SteamStoreMethod; readonly params: SteamParams }
  /**
   * Several calls, possibly to several upstreams (lib/steam/composites.ts).
   * `run` returns an already validated result.
   */
  | { readonly upstream: "composite"; readonly run: (io: UpstreamIO) => Promise<unknown> };

const web = (method: SteamWebApiMethod, params: SteamParams): RequestPlan =>
  ({ upstream: "webapi", method, params });
const store = (method: SteamStoreMethod, params: SteamParams): RequestPlan =>
  ({ upstream: "store", method, params });
const composite = (run: (io: UpstreamIO) => Promise<unknown>): RequestPlan =>
  ({ upstream: "composite", run });

/** How each resource is refreshed. Argument order matches `cacheKey`. */
const REQUESTS: { readonly [R in SteamResource]: (...args: KeyArgs<R>) => RequestPlan } = {
  playerSummary: (steamid) => web("GetPlayerSummaries", { steamids: steamid }),
  ownedGames: (steamid) =>
    web("GetOwnedGames", { steamid, include_appinfo: true, include_played_free_games: true }),
  recentlyPlayed: (steamid) => web("GetRecentlyPlayedGames", { steamid }),
  friendList: (steamid) => web("GetFriendList", { steamid, relationship: "friend" }),
  playerAchievements: (steamid, appid) => web("GetPlayerAchievements", { steamid, appid }),
  achievementSchema: (appid) => web("GetSchemaForGame", { appid }),
  appDetails: (appid, cc) => store("appdetails", { appids: appid, cc }),
  appPrice: (appid, cc) => store("appdetails", { appids: appid, cc, filters: "price_overview" }),
  appNews: (appid) => web("GetNewsForApp", { appid, count: 10, maxlength: 500 }),
  vanityUrl: (name) => web("ResolveVanityURL", { vanityurl: name }),
  storeSpecials: (cc) => store("featuredcategories", { cc, l: "english" }),
  salePage: (cc, page) => composite((io) => fetchSalePage(io, cc, page)),
  dealsFallback: (cc) => composite((io) => fetchDealsFallback(io, cc)),
  steamWishlistIds: (steamid) => composite((io) => fetchSteamWishlistIds(io, steamid)),
  wishlistView: (steamid, localAppids) =>
    composite((io) => fetchWishlistView(io, steamid, localAppids, "us")),
  itadHistory: (appid, cc) => composite((io) => fetchItadHistory(io, appid, cc)),
  // Summary only: one review on the first page carries query_summary.
  // filter 1 = Recent (day_range does not apply), review_type 0 = all,
  // purchase_type 0 = Steam purchases (what the store page's score counts).
  currentPlayers: (appid) => web("GetNumberOfCurrentPlayers", { appid }),
  appStoreMeta: (appid, cc) => web("GetItems", { input_json: storeMetaInput(appid, cc) }),
  steamTags: (language) => web("GetTagList", { language }),
  itadAppPrices: (appid, cc) => composite((io) => fetchItadAppPrices(io, appid, cc)),
  appReviews: (appid) =>
    web("GetAppReviews", {
      input_json: JSON.stringify({
        appid,
        filter: 1,
        languages: ["all"],
        review_type: 0,
        purchase_type: 0,
        num_per_page: 1,
      }),
    }),
};

// =============================================================================
// peekCached: bulk, cache-only read
// =============================================================================

/** Keys per IN (...) query, so the request URL stays short. */
const PEEK_CHUNK = 100;

/**
 * Reads many cached entries of one GLOBAL resource in a few queries. Never
 * calls Steam, never refreshes, never takes a lease: an entry that is
 * missing, expired or only a lease placeholder comes back as null, and the
 * caller decides whether to fetch it with cachedFetch.
 *
 * Fresh and stale entries are both returned (`meta.stale` tells them apart).
 * Player-scoped resources are refused: this has no session check.
 *
 * Best effort: if the database cannot be read, every entry is null.
 *
 * @returns one result per input, in the same order.
 */
export async function peekCached<R extends SteamResource>(
  resource: R,
  argsList: readonly KeyArgs<R>[],
): Promise<(CachedResult<unknown> | null)[]> {
  if (TTL[resource].scope !== "global") {
    throw new CachedFetchError("auth_required", resource);
  }
  const keyOf = cacheKey[resource] as (...a: readonly unknown[]) => string;
  const keys = argsList.map((args) => keyOf(...(args as readonly unknown[])));
  const found = new Map<string, CacheRow>();

  try {
    const unique = [...new Set(keys)];
    for (let i = 0; i < unique.length; i += PEEK_CHUNK) {
      const result = await getSupabaseAdmin()
        .from("api_cache")
        .select("key,payload,status,fetched_at,fresh_until,stale_until")
        .in("key", unique.slice(i, i + PEEK_CHUNK));
      if (result.error) {
        logCache(resource, "cache_peek_failed", dbLabel(result.error));
        return keys.map(() => null);
      }
      for (const row of Array.isArray(result.data) ? (result.data as unknown[]) : []) {
        const key = (row as { key?: unknown } | null)?.key;
        if (typeof key === "string" && isCacheRow(row)) found.set(key, row);
      }
    }
  } catch (err) {
    logCache(resource, "cache_peek_failed", failureLabel(err));
    return keys.map(() => null);
  }

  return keys.map((key) => {
    const row = found.get(key);
    if (!row || !isServable(row)) return null;
    return fromRow<unknown>(row, classifyFreshness(row) !== "fresh");
  });
}

// =============================================================================
// cachedFetch
// =============================================================================

/** Everything one read needs, resolved once. */
interface ReadContext<T> {
  readonly resource: SteamResource;
  readonly policy: TtlPolicy;
  readonly key: string;
  readonly plan: RequestPlan;
  readonly ownerSteamid: string | null;
  readonly validate: (raw: unknown) => Validated<T>;
  readonly onRefreshed?: (data: T) => Promise<void>;
}

/**
 * Reads one Steam resource through the cache.
 *
 * @returns the data (or a cached "private" / "not_found" answer) with its age.
 * @throws CachedFetchError when nothing can be served.
 */
export async function cachedFetch<R extends SteamResource, T>(
  options: CachedFetchOptions<R, T>,
): Promise<CachedResult<T>> {
  const { resource, session = null, priority = "interactive" } = options;
  const policy: TtlPolicy = TTL[resource];

  // Player data is never served, or fetched on our quota, for anonymous callers.
  if (policy.scope === "player" && !session) {
    throw new CachedFetchError("auth_required", resource);
  }

  // The two tables are keyed by the same resource name, so the argument tuple
  // fits both functions. TypeScript cannot follow that through a generic R.
  const args = options.keyArgs as readonly unknown[];
  const key = (cacheKey[resource] as (...a: readonly unknown[]) => string)(...args);
  const plan = (REQUESTS[resource] as (...a: readonly unknown[]) => RequestPlan)(...args);

  const ctx: ReadContext<T> = {
    resource,
    policy,
    key,
    plan,
    // For player-scoped resources the first key argument is the SteamID.
    ownerSteamid: policy.scope === "player" ? String(args[0]) : null,
    validate: options.validate,
    onRefreshed: options.onRefreshed,
  };

  const row = await readRow(ctx);

  if (row && isServable(row)) {
    if (classifyFreshness(row) === "fresh") {
      return fromRow<T>(row, false);
    }
    // Stale: answer now, refresh out of band.
    scheduleBackgroundRefresh(ctx, row, options.waitUntil);
    return fromRow<T>(row, true);
  }

  // Miss, expired, or an empty placeholder left by a failed first fetch.
  const tier: QuotaTier =
    priority === "cron" ? "background" : session ? "signedIn" : "anonymous";
  return blockingRefresh(ctx, tier, row !== null);
}

// =============================================================================
// Blocking path (miss)
// =============================================================================

async function blockingRefresh<T>(
  ctx: ReadContext<T>,
  tier: QuotaTier,
  rowExists: boolean,
): Promise<CachedResult<T>> {
  let leased: boolean;
  try {
    leased = await acquireLease(ctx, rowExists);
  } catch {
    throw new CachedFetchError("storage_unavailable", ctx.resource, 5);
  }

  if (!leased) {
    // Another instance is already fetching this key. Wait for its result
    // rather than spend a second Steam call on the same data.
    const arrived = await pollForRow(ctx);
    if (arrived) return fromRow<T>(arrived, classifyFreshness(arrived) !== "fresh");
    throw new CachedFetchError("busy", ctx.resource, 2);
  }

  try {
    return await refreshFromSteam(ctx, tier);
  } catch (err) {
    // The lease is deliberately not released. Until it expires (at most
    // 15 s) other requests for this key wait instead of repeating a call
    // that just failed.
    throw toCachedFetchError(err, ctx.resource);
  }
}

async function pollForRow<T>(ctx: ReadContext<T>): Promise<CacheRow | null> {
  for (let i = 0; i < POLL_ATTEMPTS; i++) {
    await delay(POLL_INTERVAL_MS);
    try {
      const row = await readRow(ctx);
      if (row && isServable(row)) return row;
    } catch {
      return null;
    }
  }
  return null;
}

// =============================================================================
// Background path (stale)
// =============================================================================

/** Keys this instance is already refreshing. Saves a lease query per request. */
const refreshing = new Set<string>();

/**
 * Starts a stale-while-revalidate refresh and returns immediately.
 *
 * Nothing thrown inside the worker can reach the caller or surface as an
 * unhandled rejection: every await is inside the try, the promise has a
 * terminal catch, and `waitUntil` itself is guarded.
 */
function scheduleBackgroundRefresh<T>(
  ctx: ReadContext<T>,
  staleRow: CacheRow,
  waitUntil: ((work: Promise<void>) => void) | undefined,
): void {
  if (refreshing.has(ctx.key)) return;
  refreshing.add(ctx.key);

  const work: Promise<void> = (async () => {
    try {
      // Atomic claim: UPDATE ... WHERE lease_until < now. If another instance
      // holds the lease it is already refreshing this key, so do nothing.
      if (!(await acquireLease(ctx, true))) return;

      try {
        await refreshFromSteam(ctx, "background");
      } catch (err) {
        logCache(ctx.resource, "background_refresh_failed", failureLabel(err));
        await extendStaleOnError(ctx, staleRow);
      }
    } catch (err) {
      logCache(ctx.resource, "background_worker_error", failureLabel(err));
    } finally {
      refreshing.delete(ctx.key);
    }
  })().catch(() => undefined);

  try {
    waitUntil?.(work);
  } catch (err) {
    logCache(ctx.resource, "wait_until_failed", failureLabel(err));
  }
}

/** Keeps a row that is about to expire servable a little longer (doc 5.2). */
async function extendStaleOnError<T>(ctx: ReadContext<T>, row: CacheRow): Promise<void> {
  const currentStaleUntil = Date.parse(row.stale_until);
  const hardCap =
    Date.parse(row.fetched_at) + ctx.policy.staleSeconds * 1000 + STALE_IF_ERROR_MAX_EXTRA_MS;
  const target = Math.min(Date.now() + STALE_IF_ERROR_GRACE_MS, hardCap);
  if (!(target > currentStaleUntil)) return;

  const targetIso = new Date(target).toISOString();
  // The `lt` guard makes this a no-op if a newer row has been written since.
  const { error } = await getSupabaseAdmin()
    .from("api_cache")
    .update({ stale_until: targetIso })
    .eq("key", ctx.key)
    .lt("stale_until", targetIso);
  if (error) logCache(ctx.resource, "stale_extension_failed", dbLabel(error));
}

// =============================================================================
// Refresh: quota -> Steam -> validate -> write
// =============================================================================

/**
 * Fetches the resource from Steam and writes the cache row. The caller must
 * hold the lease.
 *
 * @throws SteamError for upstream and quota failures, InvalidPayloadError when
 *         the validator rejects the response.
 */
async function refreshFromSteam<T>(ctx: ReadContext<T>, tier: QuotaTier): Promise<CachedResult<T>> {
  const requestOptions = {
    acquire: makeAcquire(tier),
    signal: AbortSignal.timeout(REFRESH_DEADLINE_MS),
  };

  const io: UpstreamIO = {
    webApi: (method, params) => steamWebApi(method, params, requestOptions),
    store: (method, params) => steamStore(method, params, requestOptions),
    itad: (endpoint, request) => itadRequest(endpoint, request, requestOptions),
  };

  let raw: unknown;
  try {
    const plan = ctx.plan;
    raw =
      plan.upstream === "composite"
        ? await plan.run(io)
        : plan.upstream === "webapi"
          ? await io.webApi(plan.method, plan.params)
          : await io.store(plan.method, plan.params);
  } catch (err) {
    if (err instanceof SteamError) {
      if (err.shouldOpenBreaker) await tripBreaker(err.upstream, ctx.resource);
      // HTTP-level "private" / "not found": a valid answer. Cache it.
      if (err.kind === "private" || err.kind === "not_found") {
        return writeEntry<T>(ctx, { status: err.kind });
      }
    }
    throw err;
  }

  let validated: Validated<T>;
  try {
    validated = ctx.validate(raw);
  } catch {
    // The validator's message can quote response content, so it is dropped.
    throw new InvalidPayloadError();
  }

  const result = await writeEntry(ctx, validated);

  if (validated.status === "ok" && ctx.onRefreshed) {
    try {
      await ctx.onRefreshed(validated.data);
    } catch (err) {
      logCache(ctx.resource, "on_refreshed_failed", failureLabel(err));
    }
  }
  return result;
}

class InvalidPayloadError extends Error {
  constructor() {
    super("Steam response failed validation");
    this.name = "InvalidPayloadError";
  }
}

/**
 * Upserts the api_cache row with lifetimes from ttl.ts and releases the lease.
 * Negative answers ("private", "not_found") are stored with a null payload
 * and the 30-minute negative lifetime.
 */
async function writeEntry<T>(ctx: ReadContext<T>, entry: Validated<T>): Promise<CachedResult<T>> {
  const expiry = computeExpiry(ctx.resource, entry.status);

  const { error } = await getSupabaseAdmin()
    .from("api_cache")
    .upsert(
      {
        key: ctx.key,
        payload: entry.status === "ok" ? entry.data : null,
        status: entry.status satisfies CacheStatus,
        fetched_at: expiry.fetchedAt,
        fresh_until: expiry.freshUntil,
        stale_until: expiry.staleUntil,
        lease_until: EPOCH,
        owner_steamid: ctx.ownerSteamid,
      },
      { onConflict: "key" },
    );

  // The Steam call is already paid for and the data is good. A failed cache
  // write costs the next reader a refetch; it must not fail this one.
  if (error) logCache(ctx.resource, "cache_write_failed", dbLabel(error));

  const meta: CacheMeta = { source: "steam", fetchedAt: expiry.fetchedAt, stale: false };
  return entry.status === "ok"
    ? { status: "ok", data: entry.data, meta }
    : { status: entry.status, data: null, meta };
}

// =============================================================================
// Cache rows and leases
// =============================================================================

interface CacheRow {
  readonly payload: unknown;
  readonly status: CacheStatus;
  readonly fetched_at: string;
  readonly fresh_until: string;
  readonly stale_until: string;
}

function isCacheRow(value: unknown): value is CacheRow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.status === "ok" || v.status === "private" || v.status === "not_found") &&
    typeof v.fetched_at === "string" &&
    typeof v.fresh_until === "string" &&
    typeof v.stale_until === "string"
  );
}

/** @throws CachedFetchError("storage_unavailable") if Supabase cannot be read. */
async function readRow<T>(ctx: ReadContext<T>): Promise<CacheRow | null> {
  let result: { data: unknown; error: unknown };
  try {
    result = await getSupabaseAdmin()
      .from("api_cache")
      .select("payload,status,fetched_at,fresh_until,stale_until")
      .eq("key", ctx.key)
      .maybeSingle();
  } catch (err) {
    logCache(ctx.resource, "cache_read_failed", failureLabel(err));
    throw new CachedFetchError("storage_unavailable", ctx.resource, 5);
  }
  if (result.error) {
    logCache(ctx.resource, "cache_read_failed", dbLabel(result.error));
    throw new CachedFetchError("storage_unavailable", ctx.resource, 5);
  }
  return isCacheRow(result.data) ? result.data : null;
}

/**
 * True if the row may be sent to a user: inside its stale lifetime, and not an
 * empty placeholder (a row created only to hold a lease has status "ok" and a
 * null payload).
 */
function isServable(row: CacheRow): boolean {
  if (classifyFreshness(row) === "expired") return false;
  return row.status !== "ok" || row.payload !== null;
}

/**
 * `row.payload` was validated before it was written, so it is trusted as T.
 * If a deploy changes a payload's shape, also change its cache key (for
 * example add a version suffix in ttl.ts) so old rows are not read as the
 * new type.
 */
function fromRow<T>(row: CacheRow, stale: boolean): CachedResult<T> {
  const meta: CacheMeta = { source: "cache", fetchedAt: row.fetched_at, stale };
  return row.status === "ok"
    ? { status: "ok", data: row.payload as T, meta }
    : { status: row.status, data: null, meta };
}

/**
 * Tries to become the one instance allowed to refresh this key for the next
 * 15 seconds.
 *
 * Existing row:  UPDATE ... SET lease_until = now + 15s WHERE lease_until < now.
 *                Postgres runs that atomically, so exactly one caller gets a
 *                row back.
 * Missing row:   INSERT an already-expired placeholder holding the lease. The
 *                primary key lets exactly one caller's insert succeed.
 *
 * "now" is this instance's clock. Skew between instances only shifts when a
 * lease is considered expired; it cannot give two callers the same lease.
 *
 * @returns true if this caller now holds the lease.
 * @throws if Supabase reports an unexpected error.
 */
async function acquireLease<T>(ctx: ReadContext<T>, rowExists: boolean): Promise<boolean> {
  const db = getSupabaseAdmin();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const leaseUntil = new Date(now + REFRESH_LEASE_SECONDS * 1000).toISOString();

  if (!rowExists) {
    const insert = await db.from("api_cache").insert({
      key: ctx.key,
      payload: null,
      status: "ok",
      fetched_at: EPOCH,
      fresh_until: EPOCH,
      stale_until: EPOCH,
      lease_until: leaseUntil,
      owner_steamid: ctx.ownerSteamid,
    });
    if (!insert.error) return true;
    if (insert.error.code !== PG_UNIQUE_VIOLATION) throw new Error("lease insert failed");
    // Someone created the row a moment ago. Fall through and compete for it.
  }

  const update = await db
    .from("api_cache")
    .update({ lease_until: leaseUntil })
    .eq("key", ctx.key)
    .lt("lease_until", nowIso)
    .select("key");
  if (update.error) throw new Error("lease update failed");
  return Array.isArray(update.data) && update.data.length > 0;
}

// =============================================================================
// Quota governor and circuit breaker
// =============================================================================

/**
 * Builds the gate that lib/steam/client.ts calls before every attempt,
 * retries included. Returns false (or throws, which the client also treats as
 * a refusal) unless the breaker is closed and every budget has room.
 */
function makeAcquire(tier: QuotaTier): (attempt: AttemptContext) => Promise<boolean> {
  return async ({ upstream }) => {
    if (await isBreakerOpen(upstream)) return false;

    const now = Date.now();
    if (upstream === "itad") {
      const window = new Date(Math.floor(now / 300_000) * 300_000);
      const ceiling =
        tier === "background" ? ITAD_FIVE_MINUTE_CEILING.background : ITAD_FIVE_MINUTE_CEILING.interactive;
      return takeQuota("itad", "5min", window, ceiling);
    }
    if (upstream === "store") {
      const window = new Date(Math.floor(now / 300_000) * 300_000);
      return takeQuota("store", "5min", window, STORE_FIVE_MINUTE_CEILING);
    }

    // Minute first: if the day check then refuses, the unit wasted is one
    // that resets within 60 seconds, not one from the daily budget.
    const minute = new Date(Math.floor(now / 60_000) * 60_000);
    if (!(await takeQuota("webapi", "minute", minute, WEBAPI_MINUTE_CEILING))) return false;
    return takeQuota("webapi", "day", pacificDayStart(new Date(now)), WEBAPI_DAY_CEILING[tier]);
  };
}

async function takeQuota(
  upstream: SteamUpstream,
  kind: "day" | "minute" | "5min",
  windowStart: Date,
  ceiling: number,
): Promise<boolean> {
  const { data, error } = await getSupabaseAdmin().rpc("take_quota", {
    p_upstream: upstream,
    p_kind: kind,
    p_window: windowStart.toISOString(),
    p_ceiling: ceiling,
    p_cost: 1,
  });
  if (error) throw new Error("take_quota failed");
  return data === true;
}

/**
 * The instant today began in US Pacific time, where the daily Web API budget
 * resets (doc 5.5). Correct across daylight-saving changes: Pacific midnight
 * is always 07:00 or 08:00 UTC, so both are tried.
 */
export function pacificDayStart(now: Date = new Date()): Date {
  const pacificDate = PACIFIC_DATE.format(now); // "YYYY-MM-DD"
  const [year, month, day] = pacificDate.split("-").map(Number) as [number, number, number];
  for (const utcHour of [7, 8]) {
    const candidate = new Date(Date.UTC(year, month - 1, day, utcHour));
    if (PACIFIC_DATE.format(candidate) === pacificDate && PACIFIC_HOUR.format(candidate) === "00") {
      return candidate;
    }
  }
  // Unreachable unless Pacific time rules change. Falls back to standard time.
  return new Date(Date.UTC(year, month - 1, day, 8));
}

const PACIFIC_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const PACIFIC_HOUR = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Los_Angeles",
  hour: "2-digit",
  hourCycle: "h23",
});

/**
 * Breaker state lives in rate_buckets as rows with window_kind = 'breaker':
 * `window_start` is when the breaker tripped and `used` is its level (1-5).
 * A level-n trip stays open for min(60 * 2^(n-1), 900) seconds.
 */
interface BreakerTrip {
  readonly trippedAt: number;
  readonly level: number;
  readonly openUntil: number;
}

async function latestBreakerTrip(upstream: SteamUpstream): Promise<BreakerTrip | null> {
  const { data, error } = await getSupabaseAdmin()
    .from("rate_buckets")
    .select("window_start,used")
    .eq("bucket", upstream)
    .eq("window_kind", "breaker")
    .order("window_start", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("breaker read failed");

  const row = data as { window_start?: unknown; used?: unknown } | null;
  if (!row || typeof row.window_start !== "string" || typeof row.used !== "number") return null;

  const trippedAt = Date.parse(row.window_start);
  const level = Math.min(Math.max(1, Math.trunc(row.used)), BREAKER_MAX_LEVEL);
  const seconds = Math.min(BREAKER_BASE_SECONDS * 2 ** (level - 1), BREAKER_MAX_SECONDS);
  return { trippedAt, level, openUntil: trippedAt + seconds * 1000 };
}

async function isBreakerOpen(upstream: SteamUpstream): Promise<boolean> {
  const trip = await latestBreakerTrip(upstream);
  return trip !== null && Date.now() < trip.openUntil;
}

/** Records a 429 (or Storefront 403). Never throws: it runs on an error path. */
async function tripBreaker(upstream: SteamUpstream, resource: SteamResource): Promise<void> {
  try {
    const now = Date.now();
    const last = await latestBreakerTrip(upstream);
    const escalate =
      last !== null && now < last.openUntil + BREAKER_ESCALATION_WINDOW_SECONDS * 1000;
    const level = escalate ? Math.min(last.level + 1, BREAKER_MAX_LEVEL) : 1;

    const { error } = await getSupabaseAdmin()
      .from("rate_buckets")
      .upsert(
        {
          bucket: upstream,
          window_kind: "breaker",
          window_start: new Date(now).toISOString(),
          used: level,
        },
        { onConflict: "bucket,window_kind,window_start" },
      );
    if (error) logCache(resource, "breaker_write_failed", dbLabel(error));
    else logCache(resource, "breaker_opened", `${upstream}:level_${level}`);
  } catch (err) {
    logCache(resource, "breaker_write_failed", failureLabel(err));
  }
}

// =============================================================================
// Error mapping and logging
// =============================================================================

function toCachedFetchError(err: unknown, resource: SteamResource): CachedFetchError {
  if (err instanceof CachedFetchError) return err;
  if (err instanceof InvalidPayloadError) {
    logCache(resource, "refresh_failed", "invalid_payload");
    return new CachedFetchError("invalid_response", resource);
  }
  if (err instanceof SteamError) {
    logCache(resource, "refresh_failed", err.kind);
    switch (err.kind) {
      case "quota_denied":
        return new CachedFetchError("quota_exhausted", resource, 60);
      case "throttled":
        return new CachedFetchError("throttled", resource, err.retryAfterSeconds ?? 60);
      case "upstream_error":
      case "timeout":
      case "network":
        return new CachedFetchError("upstream_unavailable", resource, 30);
      case "invalid_response":
        return new CachedFetchError("invalid_response", resource);
      default:
        // config, forbidden, bad_request: ours to fix, not the user's to retry.
        return new CachedFetchError("internal", resource);
    }
  }
  logCache(resource, "refresh_failed", failureLabel(err));
  return new CachedFetchError("internal", resource);
}

/** A fixed, safe-to-log label for anything thrown. Never the message itself. */
function failureLabel(err: unknown): string {
  if (err instanceof SteamError) return err.kind;
  if (err instanceof CachedFetchError) return err.reason;
  return err instanceof Error ? err.name : "non_error";
}

function dbLabel(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? `db_${code}` : "db_error";
}

/**
 * One structured line per cache event. Records the resource type, an event
 * name, and a fixed label. Never a cache key (it contains a SteamID), a URL,
 * a payload, or a raw error message.
 */
function logCache(resource: SteamResource, event: string, label: string): void {
  console.error(JSON.stringify({ scope: "cache", resource, event, label }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
