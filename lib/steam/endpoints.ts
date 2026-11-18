/**
 * lib/steam/endpoints.ts
 *
 * Typed, validated access to Steam data. Route Handlers and Server Components
 * call these functions and nothing lower: each one wraps `cachedFetch` with
 *
 *   - the right resource and cache-key arguments,
 *   - a `validate` callback that checks Steam's raw JSON, recognises the
 *     "private" and "not found" answers Steam hides inside HTTP 200, and
 *   - a mapping from Steam's field names to the clean shape the UI consumes.
 *
 * The mapped shape, not Steam's raw response, is what is stored in
 * api_cache.payload. If you change one of the exported interfaces, change
 * that resource's cache key too (lib/steam/ttl.ts) so rows written in the old
 * shape are not read back as the new one.
 *
 * Written against the zod API shared by zod 3 and zod 4.
 */
import "server-only";

import { z } from "zod";

import { recordPriceObservation } from "@/lib/price-history";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import {
  DEFAULT_COUNTRY_CODE,
  appIdSchema,
  countryCodeSchema,
  steamIdSchema,
} from "@/lib/validation";

import { cachedFetch, peekCached, type CachedResult, type Validated } from "./cached-fetch";
import { asReviewSummary, parseAppReviews, type ReviewSummary } from "./reviews";
import {
  parseCurrentPlayers,
  parseStoreMeta,
  parseTagList,
  type CurrentPlayers,
  type StoreMeta,
  type SteamTagList,
} from "./insights";
import type { ItadAppPriceData } from "./composites";
import type { SteamSearchData } from "./search";
import { parseStoreSpecials } from "./specials";
import type {
  DealsPageData,
  ItadHistoryData,
  SteamWishlistIds,
  WishlistViewData,
} from "./composites";

// =============================================================================
// Shared
// =============================================================================

/** Per-request context, passed straight through to `cachedFetch`. */
export interface EndpointContext {
  /** The verified session, or null/omitted for anonymous requests. */
  readonly session?: { readonly steamid: string } | null;
  /** In a Route Handler: `(work) => after(() => work)` from next/server. */
  readonly waitUntil?: (work: Promise<void>) => void;
  /**
   * "cron" for warm-up jobs; "prefetch" for hover prefetches, which may only
   * use the lower prefetch ceilings on a cache miss. Default "interactive".
   */
  readonly priority?: "interactive" | "cron" | "prefetch";
}

/** An https URL, or null when the field is missing or is anything else. */
const httpsUrlOrNull = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/)
  .nullable()
  .catch(null);

/** A non-negative integer, or undefined when missing or malformed. */
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);

/** Steam sends Unix seconds, and 0 for "never". */
function unixSecondsToIso(seconds: number | undefined): string | null {
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

// =============================================================================
// Player summary  (ISteamUser/GetPlayerSummaries)
// =============================================================================

export const PERSONA_STATUSES = [
  "offline",
  "online",
  "busy",
  "away",
  "snooze",
  "looking_to_trade",
  "looking_to_play",
] as const;
export type PersonaStatus = (typeof PERSONA_STATUSES)[number];

export interface PlayerSummary {
  readonly steamid: string;
  readonly personaName: string;
  readonly profileUrl: string | null;
  readonly avatar: {
    /** 32 x 32 */
    readonly small: string | null;
    /** 64 x 64 */
    readonly medium: string | null;
    /** 184 x 184 */
    readonly large: string | null;
  };
  /**
   * False when the profile is private or friends-only. Name and avatar are
   * still returned by Steam; games, friends and achievements will not be.
   */
  readonly isPublic: boolean;
  /** Always "offline" for a non-public profile. */
  readonly status: PersonaStatus;
  readonly lastLogoffAt: string | null;
  readonly accountCreatedAt: string | null;
  readonly countryCode: string | null;
  /** Set while the player is in a game. `appid` is null for non-Steam games. */
  readonly currentGame: { readonly appid: number | null; readonly name: string } | null;
}

const rawPlayerSchema = z.object({
  steamid: steamIdSchema,
  personaname: z.string().max(256),
  profileurl: httpsUrlOrNull,
  avatar: httpsUrlOrNull,
  avatarmedium: httpsUrlOrNull,
  avatarfull: httpsUrlOrNull,
  communityvisibilitystate: optionalCount,
  personastate: optionalCount,
  lastlogoff: optionalCount,
  timecreated: optionalCount,
  loccountrycode: z.string().regex(/^[A-Za-z]{2}$/).optional().catch(undefined),
  gameid: z.string().max(32).optional().catch(undefined),
  gameextrainfo: z.string().max(256).optional().catch(undefined),
});

const rawPlayerSummariesSchema = z.object({
  response: z.object({ players: z.array(z.unknown()) }),
});

function validatePlayerSummary(raw: unknown, steamid: string): Validated<PlayerSummary> {
  const { players } = rawPlayerSummariesSchema.parse(raw).response;

  // Steam answers an unknown SteamID with HTTP 200 and an empty list.
  if (players.length === 0) return { status: "not_found" };

  const player = rawPlayerSchema.parse(players[0]);
  if (player.steamid !== steamid) {
    throw new Error("Steam returned a different player than the one requested");
  }

  // 3 = public. 1 = private, 2 = friends only (Steam reports both as 1 to us).
  const isPublic = player.communityvisibilitystate === 3;
  const appidDigits = player.gameid && /^\d{1,7}$/.test(player.gameid) ? Number(player.gameid) : null;

  return {
    status: "ok",
    data: {
      steamid: player.steamid,
      personaName: player.personaname,
      profileUrl: player.profileurl,
      avatar: { small: player.avatar, medium: player.avatarmedium, large: player.avatarfull },
      isPublic,
      status: PERSONA_STATUSES[player.personastate ?? 0] ?? "offline",
      lastLogoffAt: unixSecondsToIso(player.lastlogoff),
      accountCreatedAt: unixSecondsToIso(player.timecreated),
      countryCode: player.loccountrycode?.toUpperCase() ?? null,
      currentGame: player.gameextrainfo
        ? { appid: appidDigits && appidDigits > 0 ? appidDigits : null, name: player.gameextrainfo }
        : null,
    },
  };
}

/**
 * Keeps users.persona_name / avatar_url / profile_url current. This is an
 * UPDATE, not an upsert: it touches a row only if that SteamID has signed in
 * to SteamGauge, and never creates one for a profile that was merely viewed.
 */
async function syncUserProfile(summary: PlayerSummary): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("users")
    .update({
      persona_name: summary.personaName,
      avatar_url: summary.avatar.medium,
      profile_url: summary.profileUrl,
    })
    .eq("steamid", summary.steamid);
  if (error) throw new Error("users profile sync failed");
}

/**
 * A player's public identity: name, avatar, online status.
 *
 * Requires a session. Result statuses:
 *   "ok"         Data present. Check `data.isPublic` before requesting games.
 *   "not_found"  No such Steam account.
 *
 * @throws ZodError if `steamid` is malformed (validate in the route first).
 * @throws CachedFetchError if nothing can be served.
 */
export async function getPlayerSummary(
  steamid: string,
  context: EndpointContext = {},
): Promise<CachedResult<PlayerSummary>> {
  const id = steamIdSchema.parse(steamid);
  return cachedFetch({
    resource: "playerSummary",
    keyArgs: [id],
    validate: (raw) => validatePlayerSummary(raw, id),
    onRefreshed: syncUserProfile,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// Owned games  (IPlayerService/GetOwnedGames)
// =============================================================================

export interface OwnedGame {
  readonly appid: number;
  readonly name: string;
  /** Total minutes played, all time. */
  readonly playtimeMinutes: number;
  /** Minutes played in the last two weeks. */
  readonly playtimeTwoWeeksMinutes: number;
  readonly lastPlayedAt: string | null;
  /** Small square icon, or null if the game has none. */
  readonly iconUrl: string | null;
  /** True if the game has achievements or stats worth requesting. */
  readonly hasStats: boolean;
}

export interface OwnedGames {
  readonly gameCount: number;
  readonly totalPlaytimeMinutes: number;
  /** Sorted by all-time playtime, most played first. */
  readonly games: readonly OwnedGame[];
}

const rawOwnedGameSchema = z.object({
  appid: z.number().int().positive(),
  name: z.string().max(512).optional().catch(undefined),
  playtime_forever: optionalCount,
  playtime_2weeks: optionalCount,
  rtime_last_played: optionalCount,
  img_icon_url: z.string().regex(/^[0-9a-f]{40}$/).optional().catch(undefined),
  has_community_visible_stats: z.boolean().optional().catch(undefined),
});

const rawOwnedGamesSchema = z.object({
  response: z.object({
    game_count: z.number().int().nonnegative().optional(),
    games: z.array(z.unknown()).optional(),
  }),
});

/** Matches the `*.steamstatic.com` entry in our Content-Security-Policy. */
function gameIconUrl(appid: number, iconHash: string): string {
  return `https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/${appid}/${iconHash}.jpg`;
}

function validateOwnedGames(raw: unknown): Validated<OwnedGames> {
  const { game_count, games } = rawOwnedGamesSchema.parse(raw).response;

  // When "Game details" is private Steam answers HTTP 200 with an empty
  // `response` object. A public profile that owns nothing is expected to
  // still carry `game_count: 0`, which is how the two cases are told apart.
  // Confirm that against a real empty library during development.
  if (game_count === undefined && games === undefined) return { status: "private" };

  const mapped: OwnedGame[] = [];
  for (const entry of games ?? []) {
    // One malformed entry must not cost the user their whole library.
    const parsed = rawOwnedGameSchema.safeParse(entry);
    if (!parsed.success) continue;
    const game = parsed.data;
    mapped.push({
      appid: game.appid,
      name: game.name?.trim() || `App ${game.appid}`,
      playtimeMinutes: game.playtime_forever ?? 0,
      playtimeTwoWeeksMinutes: game.playtime_2weeks ?? 0,
      lastPlayedAt: unixSecondsToIso(game.rtime_last_played),
      iconUrl: game.img_icon_url ? gameIconUrl(game.appid, game.img_icon_url) : null,
      hasStats: game.has_community_visible_stats ?? false,
    });
  }
  mapped.sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || a.name.localeCompare(b.name));

  return {
    status: "ok",
    data: {
      gameCount: mapped.length,
      totalPlaytimeMinutes: mapped.reduce((sum, game) => sum + game.playtimeMinutes, 0),
      games: mapped,
    },
  };
}

/**
 * A player's game library with playtime.
 *
 * Requires a session. Result statuses:
 *   "ok"       Library present (possibly empty).
 *   "private"  The player's game details are not public.
 *
 * @throws ZodError if `steamid` is malformed (validate in the route first).
 * @throws CachedFetchError if nothing can be served.
 */
export async function getOwnedGames(
  steamid: string,
  context: EndpointContext = {},
): Promise<CachedResult<OwnedGames>> {
  const id = steamIdSchema.parse(steamid);
  return cachedFetch({
    resource: "ownedGames",
    keyArgs: [id],
    validate: validateOwnedGames,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// App details  (Storefront appdetails)
// =============================================================================

export interface AppPrice {
  /** ISO 4217 code, e.g. "USD". */
  readonly currency: string;
  /** Prices are in the currency's minor unit (cents). */
  readonly initial: number;
  readonly final: number;
  /** 0 when not on sale. */
  readonly discountPercent: number;
  /** Steam's own display string for `final`, e.g. "$59.99". */
  readonly finalFormatted: string | null;
}

export interface AppDetails {
  readonly appid: number;
  readonly name: string;
  /** "game", "dlc", "demo", "music", ... or "unknown". */
  readonly type: string;
  readonly isFree: boolean;
  /** Plain text. Tags are stripped; render it as text, never as HTML. */
  readonly shortDescription: string;
  readonly headerImage: string | null;
  readonly website: string | null;
  readonly developers: readonly string[];
  readonly publishers: readonly string[];
  readonly genres: readonly string[];
  readonly categories: readonly string[];
  readonly platforms: { readonly windows: boolean; readonly mac: boolean; readonly linux: boolean };
  readonly releaseDate: {
    readonly comingSoon: boolean;
    /** Steam's display string in the store's locale, e.g. "21 Aug, 2012". */
    readonly display: string | null;
  };
  readonly metacriticScore: number | null;
  /** Null for free games and for games not sold in the requested country. */
  readonly price: AppPrice | null;
  readonly screenshots: readonly { readonly thumbnail: string; readonly full: string }[];
}

const MAX_LIST_ITEMS = 20;
const MAX_SCREENSHOTS = 12;

const stringList = z.array(z.string().max(256)).optional().catch(undefined);
const describedList = z
  .array(z.object({ description: z.string().max(256) }))
  .optional()
  .catch(undefined);

const rawAppDataSchema = z.object({
  name: z.string().min(1).max(512),
  type: z.string().max(32).optional().catch(undefined),
  is_free: z.boolean().optional().catch(undefined),
  short_description: z.string().max(4096).optional().catch(undefined),
  header_image: httpsUrlOrNull,
  website: z.string().max(2048).regex(/^https?:\/\/\S+$/).nullable().catch(null),
  developers: stringList,
  publishers: stringList,
  genres: describedList,
  categories: describedList,
  platforms: z
    .object({ windows: z.boolean(), mac: z.boolean(), linux: z.boolean() })
    .partial()
    .optional()
    .catch(undefined),
  release_date: z
    .object({ coming_soon: z.boolean().optional(), date: z.string().max(64).optional() })
    .optional()
    .catch(undefined),
  metacritic: z.object({ score: z.number().int().min(0).max(100) }).optional().catch(undefined),
  price_overview: z
    .object({
      currency: z.string().regex(/^[A-Z]{3}$/),
      initial: z.number().int().nonnegative(),
      final: z.number().int().nonnegative(),
      discount_percent: z.number().int().min(0).max(100),
      final_formatted: z.string().max(64).optional(),
    })
    .optional()
    .catch(undefined),
  screenshots: z.array(z.unknown()).optional().catch(undefined),
});

const rawScreenshotSchema = z.object({
  path_thumbnail: z.string().max(2048).regex(/^https:\/\/\S+$/),
  path_full: z.string().max(2048).regex(/^https:\/\/\S+$/),
});

/** The Storefront wraps every answer as { "<appid>": { success, data? } }. */
const rawAppDetailsEnvelopeSchema = z.record(
  z.string(),
  z.object({ success: z.boolean(), data: z.unknown().optional() }),
);

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

/**
 * Steam descriptions can carry tags and HTML entities. This returns plain
 * text for React to render as a text node. It is not an HTML sanitizer: the
 * output can contain "<" and must never be passed to dangerouslySetInnerHTML.
 */
function toPlainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => HTML_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .trim();
}

function validateAppDetails(raw: unknown, appid: number): Validated<AppDetails> {
  const entry = rawAppDetailsEnvelopeSchema.parse(raw)[String(appid)];
  if (!entry) throw new Error("Storefront response has no entry for the requested app");

  // `success: false` covers both "no such app" and "not available in this
  // country". Either way there is nothing to show.
  if (!entry.success || entry.data === undefined) return { status: "not_found" };

  const data = rawAppDataSchema.parse(entry.data);

  const screenshots: { thumbnail: string; full: string }[] = [];
  for (const shot of data.screenshots ?? []) {
    if (screenshots.length >= MAX_SCREENSHOTS) break;
    const parsed = rawScreenshotSchema.safeParse(shot);
    if (parsed.success) {
      screenshots.push({ thumbnail: parsed.data.path_thumbnail, full: parsed.data.path_full });
    }
  }

  const price = data.price_overview;

  return {
    status: "ok",
    data: {
      // The requested id, not data.steam_appid: Steam can answer for a parent
      // app, and the cache key and steam_apps row belong to what was asked.
      appid,
      name: data.name.trim(),
      type: data.type ?? "unknown",
      isFree: data.is_free ?? false,
      shortDescription: toPlainText(data.short_description ?? ""),
      headerImage: data.header_image,
      website: data.website,
      developers: (data.developers ?? []).slice(0, MAX_LIST_ITEMS),
      publishers: (data.publishers ?? []).slice(0, MAX_LIST_ITEMS),
      genres: (data.genres ?? []).slice(0, MAX_LIST_ITEMS).map((genre) => genre.description),
      categories: (data.categories ?? []).slice(0, MAX_LIST_ITEMS).map((c) => c.description),
      platforms: {
        windows: data.platforms?.windows ?? false,
        mac: data.platforms?.mac ?? false,
        linux: data.platforms?.linux ?? false,
      },
      releaseDate: {
        comingSoon: data.release_date?.coming_soon ?? false,
        display: data.release_date?.date?.trim() || null,
      },
      metacriticScore: data.metacritic?.score ?? null,
      price: price
        ? {
            currency: price.currency,
            initial: price.initial,
            final: price.final,
            discountPercent: price.discount_percent,
            finalFormatted: price.final_formatted ?? null,
          }
        : null,
      screenshots,
    },
  };
}

/**
 * Lazy catalog population (architecture doc 4.4): every fresh fetch of an
 * app's details upserts its steam_apps row, which is what makes the app
 * searchable and trackable. Exported so the wishlist can also ensure the row
 * exists when details came from cache.
 */
export async function upsertCatalogEntry(app: AppDetails): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("steam_apps")
    .upsert(
      {
        appid: app.appid,
        name: app.name,
        app_type: app.type,
        header_image: app.headerImage,
        is_free: app.isFree,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "appid" },
    );
  if (error) throw new Error("steam_apps upsert failed");
}

/**
 * Store page data for one app.
 *
 * No session required. Result statuses:
 *   "ok"         Details present.
 *   "not_found"  No such app, or not available in `countryCode`.
 *
 * @param countryCode  One of SUPPORTED_COUNTRY_CODES. Decides price and currency.
 * @throws ZodError if `appid` or `countryCode` is invalid (validate in the route first).
 * @throws CachedFetchError if nothing can be served.
 */
export async function getAppDetails(
  appid: number | string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<AppDetails>> {
  const id = appIdSchema.parse(appid);
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "appDetails",
    keyArgs: [id, cc],
    validate: (raw) => validateAppDetails(raw, id),
    onRefreshed: async (app) => {
      await upsertCatalogEntry(app);
      // A live price was just seen: add it to our own price history.
      if (app.price) await recordPriceObservation(app.appid, cc, app.price);
    },
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// App price  (Storefront appdetails, price_overview only)
// =============================================================================

export interface AppPriceInfo {
  readonly appid: number;
  /** Null for free games and for games with no price in the requested country. */
  readonly price: AppPrice | null;
}

const rawPriceOverviewSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  initial: z.number().int().nonnegative(),
  final: z.number().int().nonnegative(),
  discount_percent: z.number().int().min(0).max(100),
  final_formatted: z.string().max(64).optional(),
});

function validateAppPrice(raw: unknown, appid: number): Validated<AppPriceInfo> {
  const entry = rawAppDetailsEnvelopeSchema.parse(raw)[String(appid)];
  if (!entry) throw new Error("Storefront response has no entry for the requested app");
  if (!entry.success) return { status: "not_found" };

  // With filters=price_overview, a free or unpriced app comes back as
  // `data: []` (an empty array), not as an object without the field.
  const data = entry.data;
  const overview =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as { price_overview?: unknown }).price_overview
      : undefined;
  if (overview === undefined) return { status: "ok", data: { appid, price: null } };

  const price = rawPriceOverviewSchema.parse(overview);
  return {
    status: "ok",
    data: {
      appid,
      price: {
        currency: price.currency,
        initial: price.initial,
        final: price.final,
        discountPercent: price.discount_percent,
        finalFormatted: price.final_formatted ?? null,
      },
    },
  };
}

/**
 * The current store price of one app. A lighter, shorter-lived cache entry
 * than full details (fresh for 3 hours), so sale prices stay reasonably
 * current. Each live fetch is also added to our own price history.
 *
 * No session required. Result statuses:
 *   "ok"         `data.price` is the price, or null if the app has none.
 *   "not_found"  No such app, or not available in `countryCode`.
 *
 * @throws ZodError if `appid` or `countryCode` is invalid.
 * @throws CachedFetchError if nothing can be served.
 */
export async function getAppPrice(
  appid: number | string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<AppPriceInfo>> {
  const id = appIdSchema.parse(appid);
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "appPrice",
    keyArgs: [id, cc],
    validate: (raw) => validateAppPrice(raw, id),
    onRefreshed: async (info) => {
      if (info.price) await recordPriceObservation(info.appid, cc, info.price);
    },
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// Store specials  (Storefront featuredcategories)
// =============================================================================

// SaleItem, StoreSpecials and the parser live in ./specials so the deals
// composites can use them without importing this module.
export type { SaleItem, StoreSpecials } from "./specials";
import type { StoreSpecials } from "./specials";

/**
 * Discounted games Steam is featuring right now: its "Specials" list plus any
 * top seller that is on sale. One Storefront call, shared by every user for
 * an hour.
 *
 * No session required. An empty list is a normal "ok" result.
 *
 * @throws ZodError if `countryCode` is not supported.
 * @throws CachedFetchError if nothing can be served.
 */
export async function getStoreSpecials(
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<StoreSpecials>> {
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "storeSpecials",
    keyArgs: [cc],
    validate: parseStoreSpecials,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// Composite resources (lib/steam/composites.ts)
// =============================================================================

export type {
  DealRecord,
  DealsPageData,
  ItadHistoryData,
  SteamWishlistEntry,
  SteamWishlistIds,
  WishlistLows,
  WishlistViewData,
} from "./composites";
export { SALE_PAGE_SIZE, SALE_TOP_SELLERS, STEAM_WISHLIST_LIMIT } from "./composites";

/**
 * Composite refreshes validate every upstream response themselves and return
 * a finished `Validated` result, so the engine's validate step only confirms
 * the envelope.
 */
function compositeResult<T>(raw: unknown): Validated<T> {
  const status = (raw as { status?: unknown } | null)?.status;
  if (status === "private" || status === "not_found") return { status };
  if (status === "ok" && typeof (raw as { data?: unknown }).data === "object") {
    return raw as Validated<T>;
  }
  throw new Error("composite refresh returned an unexpected shape");
}

/**
 * One page (200) of Steam's discounted top sellers, from Steam's own store
 * query, with Steam ratings, release dates, sale end times and (with an ITAD
 * key) historical lows and the cheapest other store. Shared by all users,
 * fresh for an hour.
 */
export async function getSalePage(
  page: number,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<DealsPageData>> {
  if (!Number.isInteger(page) || page < 0 || page > 9) throw new RangeError("page out of range");
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "salePage",
    keyArgs: [cc, page],
    validate: compositeResult<DealsPageData>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/** Steam's featured specials with the same data. Used only if the sale query fails. */
export async function getDealsFallback(
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<DealsPageData>> {
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "dealsFallback",
    keyArgs: [cc],
    validate: compositeResult<DealsPageData>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/** The appids on a player's public Steam wishlist. Requires a session. */
export async function getSteamWishlistIds(
  steamid: string,
  context: EndpointContext = {},
): Promise<CachedResult<SteamWishlistIds>> {
  const id = steamIdSchema.parse(steamid);
  return cachedFetch({
    resource: "steamWishlistIds",
    keyArgs: [id],
    validate: compositeResult<SteamWishlistIds>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/**
 * The Steam wishlist plus locally watched apps, with store data and (when an
 * ITAD key is configured) historical lows. Requires a session.
 *
 * @param localAppids  Appids on the SteamGauge watchlist. Sorted here, so the
 *                     same set always maps to the same cache entry.
 */
export async function getWishlistView(
  steamid: string,
  localAppids: readonly number[],
  context: EndpointContext = {},
  /** Runs after a live refresh (never on a cache hit). Failures are logged, not thrown. */
  onRefreshed?: (data: WishlistViewData) => Promise<void>,
): Promise<CachedResult<WishlistViewData>> {
  const id = steamIdSchema.parse(steamid);
  const csv = [...new Set(localAppids.map((appid) => appIdSchema.parse(appid)))]
    .sort((a, b) => a - b)
    .join(",");
  return cachedFetch({
    resource: "wishlistView",
    keyArgs: [id, csv],
    validate: compositeResult<WishlistViewData>,
    onRefreshed,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/**
 * Multi-year Steam price history for one app from IsThereAnyDeal, one point
 * per day with a price change. Shared by all users, fresh for 12 hours.
 * Requires ITAD_API_KEY.
 *
 * Result statuses: "ok", or "not_found" when ITAD does not know the app.
 */
export async function getItadHistory(
  appid: number | string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<ItadHistoryData>> {
  const id = appIdSchema.parse(appid);
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "itadHistory",
    keyArgs: [id, cc],
    validate: compositeResult<ItadHistoryData>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// Review summaries  (IUserReviewsService/GetAppReviews)
// =============================================================================

export type { ReviewSummary } from "./reviews";

/**
 * Steam's review totals for one app: count and share positive. Shared by all
 * users, fresh for 3 days. Used only for apps where the batched GetItems
 * call returned no review summary.
 *
 * Result statuses: "ok", or "not_found" for an appid Steam does not know.
 */
export async function getAppReviews(
  appid: number | string,
  context: EndpointContext = {},
): Promise<CachedResult<ReviewSummary>> {
  const id = appIdSchema.parse(appid);
  return cachedFetch({
    resource: "appReviews",
    keyArgs: [id],
    validate: (raw) => parseAppReviews(raw, id),
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/**
 * Cached review summaries for many apps in a few database queries, with no
 * Steam calls. Apps with nothing usable in the cache are absent from the map.
 */
export async function peekAppReviews(
  appids: readonly number[],
): Promise<Map<number, ReviewSummary>> {
  const ids = [...new Set(appids.map((appid) => appIdSchema.parse(appid)))];
  const results = await peekCached("appReviews", ids.map((id) => [id] as const));
  const found = new Map<number, ReviewSummary>();
  results.forEach((result, index) => {
    if (result?.status !== "ok") return;
    const summary = asReviewSummary(result.data);
    if (summary && summary.appid === ids[index]) found.set(summary.appid, summary);
  });
  return found;
}

// =============================================================================
// Game facts for expanded Deals rows and Wishlist cards
// =============================================================================

export type { CurrentPlayers, StoreMeta, SteamTagList } from "./insights";
export type { ItadAppPriceData, ItadStorePrice } from "./composites";

/** Live concurrent players. Shared by all users, fresh for 10 minutes. */
export async function getCurrentPlayers(
  appid: number | string,
  context: EndpointContext = {},
): Promise<CachedResult<CurrentPlayers>> {
  const id = appIdSchema.parse(appid);
  return cachedFetch({
    resource: "currentPlayers",
    keyArgs: [id],
    validate: (raw) => parseCurrentPlayers(raw, id),
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/** Developers, publishers, franchises and tag ids from GetItems. Fresh for a day. */
export async function getAppStoreMeta(
  appid: number | string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<StoreMeta>> {
  const id = appIdSchema.parse(appid);
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "appStoreMeta",
    keyArgs: [id, cc],
    validate: (raw) => parseStoreMeta(raw, id),
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/** Every Steam tag's name, in English. One shared entry, fresh for a week. */
export async function getSteamTags(context: EndpointContext = {}): Promise<CachedResult<SteamTagList>> {
  return cachedFetch({
    resource: "steamTags",
    keyArgs: ["english"],
    validate: parseTagList,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

/** One game's current price at every store ITAD tracks, with lows. Requires ITAD_API_KEY. */
export async function getItadAppPrices(
  appid: number | string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<ItadAppPriceData>> {
  const id = appIdSchema.parse(appid);
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "itadAppPrices",
    keyArgs: [id, cc],
    validate: compositeResult<ItadAppPriceData>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}

// =============================================================================
// Global search (Steam store search + store data)
// =============================================================================

export type { SteamSearchData, SteamSearchHit } from "./search";

/**
 * Steam's store search for an already normalised term (lib/title-search.ts),
 * with capsule art, release year and price. Shared by all users for a day.
 */
export async function getStoreSearch(
  normalizedTerm: string,
  countryCode: string = DEFAULT_COUNTRY_CODE,
  context: EndpointContext = {},
): Promise<CachedResult<SteamSearchData>> {
  if (!/^[a-z0-9 ]{2,64}$/.test(normalizedTerm)) throw new RangeError("search term must be normalised");
  const cc = countryCodeSchema.parse(countryCode);
  return cachedFetch({
    resource: "storeSearch",
    keyArgs: [cc, normalizedTerm],
    validate: compositeResult<SteamSearchData>,
    session: context.session,
    waitUntil: context.waitUntil,
    priority: context.priority,
  });
}
