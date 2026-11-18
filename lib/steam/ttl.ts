/**
 * lib/steam/ttl.ts
 *
 * Single source of truth for cache lifetimes (architecture doc 5.3).
 * Change a number here and in the doc's table in the same pull request.
 *
 * Two lifetimes per resource, both measured from the moment of the fetch:
 *
 *   fresh  Until then, serve from api_cache with no Steam call.
 *   stale  Until then, serve the cached value and refresh in the background.
 *          After it, the entry is unusable and is purged by the daily cron.
 *
 * This module has no secrets and no I/O. It is safe to import anywhere,
 * including Client Components (for example to set TanStack Query staleTime).
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Matches the `bucket` values used in rate_buckets. */
/**
 * Matches the `bucket` values used in rate_buckets. "itad" is the
 * IsThereAnyDeal API (lib/itad/client.ts), which has its own budget.
 */
export type SteamUpstream = "webapi" | "store" | "itad";

/** Matches the CHECK constraint on api_cache.status. */
export type CacheStatus = "ok" | "private" | "not_found";

export interface TtlPolicy {
  /** Seconds a successful response is served without contacting Steam. */
  readonly freshSeconds: number;
  /** Seconds a successful response may still be served while refreshing. */
  readonly staleSeconds: number;
  /** Which Steam budget a refresh of this resource is charged to. */
  readonly upstream: SteamUpstream;
  /**
   * "player": belongs to one SteamID. Set api_cache.owner_steamid, and send
   *           the HTTP response with `Cache-Control: private, no-store`.
   * "global": identical for every user. Cached once, shared by all.
   */
  readonly scope: "player" | "global";
}

/**
 * One entry per row of the table in architecture doc 5.3.
 *
 * | Resource             | Fresh  | Stale | Steam call                              |
 * |----------------------|--------|-------|-----------------------------------------|
 * | playerSummary        | 5 min  | 24 h  | ISteamUser/GetPlayerSummaries           |
 * | ownedGames           | 1 h    | 7 d   | IPlayerService/GetOwnedGames            |
 * | recentlyPlayed       | 15 min | 24 h  | IPlayerService/GetRecentlyPlayedGames   |
 * | friendList           | 6 h    | 7 d   | ISteamUser/GetFriendList                |
 * | playerAchievements   | 30 min | 7 d   | ISteamUserStats/GetPlayerAchievements   |
 * | achievementSchema    | 7 d    | 30 d  | ISteamUserStats/GetSchemaForGame        |
 * | appDetails           | 24 h   | 14 d  | Storefront appdetails                   |
 * | appPrice             | 3 h    | 24 h  | Storefront appdetails (price filter)    |
 * | appNews              | 1 h    | 7 d   | ISteamNews/GetNewsForApp                |
 * | vanityUrl            | 30 d   | 30 d  | ISteamUser/ResolveVanityURL             |
 * | storeSpecials        | 1 h    | 24 h  | Storefront featuredcategories           |
 * | salePage             | 1 h    | 24 h  | IStoreQueryService/Query + ITAD by appid|
 * | dealsFallback        | 1 h    | 24 h  | featuredcategories + GetItems + ITAD    |
 * | steamWishlistIds     | 30 min | 24 h  | IWishlistService/GetWishlist            |
 * | wishlistView         | 30 min | 24 h  | GetWishlist + GetItems + ITAD prices    |
 * | itadHistory          | 12 h   | 7 d   | ITAD lookup + games/history (all years) |
 * | appReviews           | 3 d    | 14 d  | IUserReviewsService/GetAppReviews       |
 * | currentPlayers       | 10 min | 2 h   | ISteamUserStats/GetNumberOfCurrentPlayers |
 * | appStoreMeta         | 24 h   | 14 d  | GetItems: developers, publishers, tags  |
 * | steamTags            | 7 d    | 30 d  | IStoreService/GetTagList                |
 * | itadAppPrices        | 1 h    | 24 h  | ITAD lookup + prices at every store     |
 * | storeSearch          | 24 h   | 7 d   | Storefront storesearch + GetItems       |
 * | itadId               | 30 d   | 90 d  | ITAD lookup (Steam AppID -> ITAD id)    |
 */
export const TTL = {
  playerSummary:      { freshSeconds: 5 * MINUTE,  staleSeconds: 24 * HOUR, upstream: "webapi", scope: "player" },
  ownedGames:         { freshSeconds: 1 * HOUR,    staleSeconds: 7 * DAY,   upstream: "webapi", scope: "player" },
  recentlyPlayed:     { freshSeconds: 15 * MINUTE, staleSeconds: 24 * HOUR, upstream: "webapi", scope: "player" },
  friendList:         { freshSeconds: 6 * HOUR,    staleSeconds: 7 * DAY,   upstream: "webapi", scope: "player" },
  playerAchievements: { freshSeconds: 30 * MINUTE, staleSeconds: 7 * DAY,   upstream: "webapi", scope: "player" },
  achievementSchema:  { freshSeconds: 7 * DAY,     staleSeconds: 30 * DAY,  upstream: "webapi", scope: "global" },
  appDetails:         { freshSeconds: 24 * HOUR,   staleSeconds: 14 * DAY,  upstream: "store",  scope: "global" },
  appPrice:           { freshSeconds: 3 * HOUR,    staleSeconds: 24 * HOUR, upstream: "store",  scope: "global" },
  appNews:            { freshSeconds: 1 * HOUR,    staleSeconds: 7 * DAY,   upstream: "webapi", scope: "global" },
  vanityUrl:          { freshSeconds: 30 * DAY,    staleSeconds: 30 * DAY,  upstream: "webapi", scope: "global" },
  storeSpecials:      { freshSeconds: 1 * HOUR,    staleSeconds: 24 * HOUR, upstream: "store",  scope: "global" },
  salePage:           { freshSeconds: 1 * HOUR,    staleSeconds: 24 * HOUR, upstream: "webapi", scope: "global" },
  dealsFallback:      { freshSeconds: 1 * HOUR,    staleSeconds: 24 * HOUR, upstream: "store",  scope: "global" },
  steamWishlistIds:   { freshSeconds: 30 * MINUTE, staleSeconds: 24 * HOUR, upstream: "webapi", scope: "player" },
  wishlistView:       { freshSeconds: 30 * MINUTE, staleSeconds: 24 * HOUR, upstream: "webapi", scope: "player" },
  itadHistory:        { freshSeconds: 12 * HOUR,   staleSeconds: 7 * DAY,   upstream: "itad",   scope: "global" },
  // Review totals move slowly. Deals and the wishlist read these in bulk from
  // the cache (peekCached) and fetch only a few missing ones per request.
  appReviews:         { freshSeconds: 3 * DAY,     staleSeconds: 14 * DAY,  upstream: "webapi", scope: "global" },
  // Game facts for expanded Deals rows and Wishlist cards. All shared by every
  // user; only the live player count is short-lived.
  currentPlayers:     { freshSeconds: 10 * MINUTE, staleSeconds: 2 * HOUR,  upstream: "webapi", scope: "global" },
  appStoreMeta:       { freshSeconds: 24 * HOUR,   staleSeconds: 14 * DAY,  upstream: "webapi", scope: "global" },
  steamTags:          { freshSeconds: 7 * DAY,     staleSeconds: 30 * DAY,  upstream: "webapi", scope: "global" },
  itadAppPrices:      { freshSeconds: 1 * HOUR,    staleSeconds: 24 * HOUR, upstream: "itad",   scope: "global" },
  // Global search: one entry per normalised query, shared by every user.
  storeSearch:        { freshSeconds: 24 * HOUR,   staleSeconds: 7 * DAY,   upstream: "store",  scope: "global" },
  // An ITAD game id never changes for a Steam app. Cached so the price and
  // history refreshes for an expanded row skip the lookup call (v1.9); the
  // Deals and Wishlist refreshes fill it for every app they look up.
  itadId:             { freshSeconds: 30 * DAY,    staleSeconds: 90 * DAY,  upstream: "itad",   scope: "global" },
} as const satisfies Record<string, TtlPolicy>;

export type SteamResource = keyof typeof TTL;

/**
 * Negative caching. A private profile or a missing app is a valid answer, not
 * an error to retry. It is held for 30 minutes under the resource's own key
 * and is never served stale: once it expires we ask Steam again.
 */
export const NEGATIVE_TTL_SECONDS = 30 * MINUTE;

/** How long one instance holds the refresh lease on a key (doc 5.2). */
export const REFRESH_LEASE_SECONDS = 15;

/** Minimum gap between user-forced refreshes of the same resource (doc 5.3). */
export const FORCED_REFRESH_COOLDOWN_SECONDS = 2 * MINUTE;

export function getTtl(resource: SteamResource): TtlPolicy {
  return TTL[resource];
}

export interface CacheExpiry {
  /** Value for api_cache.fetched_at */
  readonly fetchedAt: string;
  /** Value for api_cache.fresh_until */
  readonly freshUntil: string;
  /** Value for api_cache.stale_until */
  readonly staleUntil: string;
}

/**
 * Computes the three api_cache timestamps for a response fetched at `now`.
 *
 * @param resource  Which row of the TTL table applies.
 * @param status    "ok" uses the resource's own TTLs. "private" and
 *                  "not_found" use the 30-minute negative TTL.
 * @param now       Injectable for tests. Defaults to the current time.
 */
export function computeExpiry(
  resource: SteamResource,
  status: CacheStatus = "ok",
  now: Date = new Date(),
): CacheExpiry {
  const policy = TTL[resource];
  const fresh = status === "ok" ? policy.freshSeconds : NEGATIVE_TTL_SECONDS;
  const stale = status === "ok" ? policy.staleSeconds : NEGATIVE_TTL_SECONDS;
  const t = now.getTime();

  return {
    fetchedAt: now.toISOString(),
    freshUntil: new Date(t + fresh * 1000).toISOString(),
    staleUntil: new Date(t + stale * 1000).toISOString(),
  };
}

/** How a cached row should be treated right now (doc 5.2). */
export type Freshness = "fresh" | "stale" | "expired";

export function classifyFreshness(
  row: { fresh_until: string; stale_until: string },
  now: Date = new Date(),
): Freshness {
  const t = now.getTime();
  if (t < Date.parse(row.fresh_until)) return "fresh";
  if (t < Date.parse(row.stale_until)) return "stale";
  return "expired";
}

/**
 * Builders for api_cache.key, matching the "Cache key" column in doc 5.3.
 *
 * Inputs must already be validated (lib/validation.ts): steamid is a 17-digit
 * SteamID64 string, appid a positive integer, cc a supported country code.
 */
export const cacheKey = {
  playerSummary: (steamid: string) => `player:${steamid}:summary`,
  ownedGames: (steamid: string) => `player:${steamid}:games`,
  recentlyPlayed: (steamid: string) => `player:${steamid}:recent`,
  friendList: (steamid: string) => `player:${steamid}:friends`,
  playerAchievements: (steamid: string, appid: number) => `player:${steamid}:ach:${appid}`,
  achievementSchema: (appid: number) => `app:${appid}:schema`,
  appDetails: (appid: number, cc: string) => `app:${appid}:details:${cc.toLowerCase()}`,
  appPrice: (appid: number, cc: string) => `app:${appid}:price:${cc.toLowerCase()}`,
  appNews: (appid: number) => `app:${appid}:news`,
  vanityUrl: (name: string) => `vanity:${name.toLowerCase()}`,
  storeSpecials: (cc: string) => `store:specials:${cc.toLowerCase()}`,
  salePage: (cc: string, page: number) => `deals:steam-sale:${cc.toLowerCase()}:${page}`,
  // "v2": rows now carry cheaperElsewhere and ITAD lows.
  dealsFallback: (cc: string) => `deals:featured:v2:${cc.toLowerCase()}`,
  steamWishlistIds: (steamid: string) => `player:${steamid}:wishlist-ids`,
  // The local watchlist is part of the input, so it is part of the key: adding
  // or removing a watched game simply produces a new entry.
  wishlistView: (steamid: string, localAppids: string) =>
    `player:${steamid}:wishlist:${fnv1a(localAppids)}`,
  // "full": requested with an explicit `since` covering every year. The
  // older key held ITAD's default window (about 3 months) and is left to expire.
  itadHistory: (appid: number, cc: string) => `app:${appid}:itad-history:full:${cc.toLowerCase()}`,
  appReviews: (appid: number) => `app:${appid}:reviews`,
  currentPlayers: (appid: number) => `app:${appid}:players`,
  appStoreMeta: (appid: number, cc: string) => `app:${appid}:store-meta:${cc.toLowerCase()}`,
  steamTags: (language: string) => `store:tags:${language}`,
  // "v2": each store now carries its link (`url`).
  itadAppPrices: (appid: number, cc: string) => `app:${appid}:itad-prices:v2:${cc.toLowerCase()}`,
  // The term is already normalised (lib/title-search.ts): lowercase a-z 0-9 and spaces.
  storeSearch: (cc: string, term: string) => `search:${cc.toLowerCase()}:${term}`,
  itadId: (appid: number) => `app:${appid}:itad-id`,
} as const satisfies Record<SteamResource, (...args: never[]) => string>;

/** Short, stable, non-cryptographic hash for cache keys (FNV-1a, 32-bit). */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
