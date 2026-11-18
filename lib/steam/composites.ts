/**
 * lib/steam/composites.ts
 *
 * Cached resources that need more than one upstream call to build. Each
 * function here is the refresh step for one resource in the cache engine
 * (lib/steam/cached-fetch.ts): it receives an UpstreamIO whose every call is
 * charged to the right quota bucket, and returns the finished, validated
 * result, which is cached as one api_cache row.
 *
 *   salePage         Steam IStoreQueryService/Query (discounted top sellers,
 *                    200 per page, store data included) -> ITAD by AppID
 *   dealsFallback    Steam featuredcategories -> GetItems -> ITAD by AppID
 *                    (only if the sale query fails)
 *   steamWishlistIds Steam GetWishlist
 *   wishlistView     Steam GetWishlist -> GetItems -> ITAD lookup -> ITAD prices
 *   itadHistory      ITAD lookup -> ITAD price history
 *   itadAppPrices    ITAD lookup -> one game's prices at every store
 *
 * The ITAD lookup (Steam AppID -> ITAD game id) must finish before prices or
 * history can be asked for, so those pairs cannot run in parallel. Instead the
 * id is cached (resource `itadId`, v1.9): the Deals and Wishlist refreshes
 * record every id they look up in bulk, and the single-game plans read it
 * first, so an expanded row usually needs one ITAD call instead of two.
 *
 * Every upstream response is checked with zod here, so the cache stores only
 * data in the shapes exported below.
 */
import { z } from "zod";

import { ITAD_STEAM_SHOP_ID, isItadConfigured } from "@/lib/itad/client";
import type { PricePoint } from "@/lib/price-history";

import type { UpstreamIO, Validated } from "./cached-fetch";
import { parseStoreSpecials } from "./specials";
import { fetchStoreItems, parseStoreItems, type StoreItem } from "./store-items";

// =============================================================================
// Shared ITAD shapes
// =============================================================================

const itadPriceSchema = z
  .object({
    amount: z.number().nonnegative(),
    amountInt: z.number().int().nonnegative().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .transform((p) => ({ cents: p.amountInt ?? Math.round(p.amount * 100), currency: p.currency }));

const optionalItadPrice = itadPriceSchema.nullable().optional().catch(null);

/** "app/620" -> 620. Packages and bundles ("sub/", "bundle/") are not apps. */
function appidFromShopId(shopId: string): number | null {
  const match = /^app\/(\d{1,7})$/.exec(shopId);
  return match?.[1] ? Number(match[1]) : null;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await worker(items[next++] as T);
    }),
  );
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// =============================================================================
// Deals
// =============================================================================

export interface CheaperElsewhere {
  /** Store name as ITAD reports it, e.g. "GOG". */
  readonly shop: string;
  /** Current price there, in cents. */
  readonly price: number;
}

export interface DealRecord {
  readonly appid: number;
  readonly name: string;
  /** "game", "dlc", or "other". */
  readonly type: "game" | "dlc" | "other";
  readonly headerImage: string | null;
  readonly capsuleImage: string | null;
  readonly currency: string;
  /** Current Steam sale price, in cents. */
  readonly price: number;
  /** Undiscounted Steam price, in cents. */
  readonly regular: number;
  readonly discountPercent: number;
  /** Lowest price ever recorded at the Steam store. Null without ITAD. */
  readonly steamLow: number | null;
  /** Lowest price at any store ITAD tracks, over the past year. Null without ITAD. */
  readonly yearLowAnyStore: number | null;
  /** ITAD's flag on the current Steam deal, passed through for the badge rules. */
  readonly itadFlag: string | null;
  /** The cheapest current price at another store, only when below Steam's. */
  readonly cheaperElsewhere: CheaperElsewhere | null;
  readonly reviewPercent: number | null;
  readonly reviewCount: number | null;
  readonly reviewLabel: string | null;
  readonly releaseDate: string | null;
  readonly comingSoon: boolean;
  readonly saleEndsAt: string | null;
}

export interface DealsPageData {
  /**
   * "steam":    Steam's own query of discounted top sellers (the normal case).
   * "featured": Steam's featured specials, used if that query fails.
   */
  readonly source: "steam" | "featured";
  readonly deals: readonly DealRecord[];
  readonly hasMore: boolean;
  /** Deals whose Steam store data (rating, release) could not be loaded. */
  readonly missingStoreData: number;
  /** True when ITAD lows were looked up for this page. */
  readonly lowsAvailable: boolean;
}

/** Apps per IStoreQueryService/Query page. Steam allows up to 1,000. */
export const SALE_PAGE_SIZE = 200;
/**
 * The pool: discounted apps among Steam's global top N sellers. This is what
 * keeps big sale titles in and the long tail of tiny discounts out.
 */
export const SALE_TOP_SELLERS = 1000;

const queryMetadataSchema = z.object({
  response: z.object({
    metadata: z
      .object({
        total_matching_records: z.number().int().nonnegative().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    ids: z
      .array(z.object({ appid: z.number().int().positive().optional().catch(undefined) }).passthrough())
      .optional()
      .catch(undefined),
    store_items: z.array(z.unknown()).optional(),
  }),
});

/** The input for one page of Steam's sale query. Exported for tests. */
export function saleQueryInput(countryCode: string, page: number): string {
  return JSON.stringify({
    query_name: "SteamGauge deals",
    query: {
      start: page * SALE_PAGE_SIZE,
      count: SALE_PAGE_SIZE,
      filters: {
        released_only: true,
        type_filters: { include_apps: true, include_games: true, include_dlc: true },
        price_filters: { min_discount_percent: 1 },
        global_top_n_sellers: SALE_TOP_SELLERS,
      },
    },
    context: { language: "english", country_code: countryCode.toUpperCase(), steam_realm: 1 },
    data_request: {
      include_basic_info: true,
      include_assets: true,
      include_release: true,
      include_reviews: true,
      include_all_purchase_options: true,
    },
  });
}

/**
 * One page (200) of Steam's discounted top sellers, straight from Steam via
 * IStoreQueryService/Query, then enriched by Steam AppID with ITAD lows and
 * the cheapest price at another store.
 *
 * One Web API call returns the apps with their store data (name, art,
 * release, reviews, price and discount end). If Steam returns ids only, the
 * store data is fetched with GetItems instead.
 */
export async function fetchSalePage(
  io: UpstreamIO,
  countryCode: string,
  page: number,
): Promise<Validated<DealsPageData>> {
  const raw = await io.webApi("StoreQuery", { input_json: saleQueryInput(countryCode, page) });
  const parsed = queryMetadataSchema.parse(raw);
  const appids = (parsed.response.ids ?? [])
    .map((entry) => entry.appid)
    .filter((appid): appid is number => appid !== undefined && appid <= 9_999_999);

  let store = new Map<number, StoreItem>();
  for (const item of parseStoreItems(raw)) store.set(item.appid, item);
  const order = appids.length > 0 ? appids : [...store.keys()];
  const missing = order.filter((appid) => !store.has(appid));
  if (missing.length > 0) {
    const extra = await fetchStoreItems(io, missing, countryCode);
    store = new Map([...store, ...extra.items]);
  }

  const total = parsed.response.metadata?.total_matching_records;
  const hasMore =
    total !== undefined ? (page + 1) * SALE_PAGE_SIZE < total : order.length >= SALE_PAGE_SIZE;

  const deals = await buildDeals(io, countryCode, order, store, () => null);
  return { status: "ok", data: { source: "steam", hasMore, ...deals } };
}

/**
 * Used only if Steam's sale query fails: Steam's featured specials (a few
 * dozen games), with the same store data and ITAD enrichment.
 */
export async function fetchDealsFallback(
  io: UpstreamIO,
  countryCode: string,
): Promise<Validated<DealsPageData>> {
  const specials = parseStoreSpecials(
    await io.store("featuredcategories", { cc: countryCode, l: "english" }),
  );
  const sale = specials.status === "ok" ? specials.data.items : [];
  const bySpecial = new Map(sale.map((item) => [item.appid, item]));
  const { items: store } = await fetchStoreItems(io, [...bySpecial.keys()], countryCode);

  const deals = await buildDeals(io, countryCode, [...bySpecial.keys()], store, (appid) => {
    const item = bySpecial.get(appid);
    return item
      ? {
          name: item.name,
          image: item.headerImage,
          currency: item.currency,
          price: item.finalPrice,
          regular: item.originalPrice,
          discountPercent: item.discountPercent,
          saleEndsAt: item.discountEndsAt,
        }
      : null;
  });
  return { status: "ok", data: { source: "featured", hasMore: false, ...deals } };
}

interface SaleFallback {
  readonly name: string;
  readonly image: string | null;
  readonly currency: string;
  readonly price: number;
  readonly regular: number;
  readonly discountPercent: number;
  readonly saleEndsAt: string | null;
}

/**
 * Turns Steam store data into deal rows, in the given order, keeping only
 * apps that are discounted right now, then adds ITAD's data by AppID.
 */
async function buildDeals(
  io: UpstreamIO,
  countryCode: string,
  order: readonly number[],
  store: ReadonlyMap<number, StoreItem>,
  fallback: (appid: number) => SaleFallback | null,
): Promise<Pick<DealsPageData, "deals" | "missingStoreData" | "lowsAvailable">> {
  const seen = new Set<number>();
  const rows: DealRecord[] = [];
  let missingStoreData = 0;
  for (const appid of order) {
    if (seen.has(appid)) continue;
    seen.add(appid);
    const info = store.get(appid);
    const extra = fallback(appid);
    const price = info?.priceFinal ?? extra?.price ?? null;
    const regular = info?.priceInitial ?? extra?.regular ?? null;
    const discountPercent = info ? info.discountPercent : (extra?.discountPercent ?? 0);
    // Only real, current discounts. Free and unpriced apps are not deals.
    if (price === null || regular === null || discountPercent <= 0 || info?.isFree) continue;
    if (!info) missingStoreData++;
    rows.push({
      appid,
      name: info?.name ?? extra?.name ?? `App ${appid}`,
      type: info?.appType ?? "game",
      headerImage: info?.headerImage ?? extra?.image ?? null,
      capsuleImage: info?.capsuleImage ?? extra?.image ?? null,
      currency: extra?.currency ?? "USD",
      price,
      regular,
      discountPercent,
      steamLow: null,
      yearLowAnyStore: null,
      itadFlag: null,
      cheaperElsewhere: null,
      reviewPercent: info?.reviewPercent ?? null,
      reviewCount: info?.reviewCount ?? null,
      reviewLabel: info?.reviewLabel ?? null,
      releaseDate: info?.releaseDate ?? null,
      comingSoon: info?.comingSoon ?? false,
      saleEndsAt: info?.saleEndsAt ?? extra?.saleEndsAt ?? null,
    });
  }

  if (!isItadConfigured() || rows.length === 0) {
    return { deals: rows, missingStoreData, lowsAvailable: false };
  }
  const itad = await fetchItadPrices(io, rows.map((row) => row.appid), countryCode);
  if (!itad) return { deals: rows, missingStoreData, lowsAvailable: false };
  const deals = rows.map((row) => {
    const found = itad.get(row.appid);
    if (!found) return row;
    const elsewhere = found.cheapestElsewhere;
    return {
      ...row,
      steamLow: found.steamLow,
      yearLowAnyStore: found.yearLowAnyStore,
      itadFlag: found.steamFlag,
      cheaperElsewhere: elsewhere && elsewhere.price < row.price ? elsewhere : null,
    };
  });
  return { deals, missingStoreData, lowsAvailable: true };
}

// =============================================================================
// ITAD enrichment by Steam AppID
// =============================================================================

export interface ItadAppPrices {
  /** Lowest price ever at the Steam store, in cents. */
  readonly steamLow: number | null;
  /** Lowest price at any store ITAD tracks in the past year, in cents. */
  readonly yearLowAnyStore: number | null;
  /** ITAD's flag on the current Steam deal (see computeBadges). */
  readonly steamFlag: string | null;
  /** Cheapest current price at a store other than Steam. */
  readonly cheapestElsewhere: CheaperElsewhere | null;
}

const itadIdsBySteamIdSchema = z.record(z.string(), z.string().uuid().nullable());

/**
 * One app's ITAD game id: from the id cache when known, else one lookup call
 * (whose answer is then cached). Null when ITAD does not know the app.
 */
export async function resolveItadId(io: UpstreamIO, appid: number): Promise<string | null> {
  const known = await io.itadIds?.get(appid);
  if (known) return known;
  const found = itadIdsBySteamIdSchema.parse(
    await io.itad("idsBySteamId", { body: [`app/${appid}`] }),
  );
  const itadId = found[`app/${appid}`] ?? null;
  if (itadId) io.itadIds?.remember(new Map([[appid, itadId]]));
  return itadId;
}

/** Plan for the `itadId` resource itself. */
export async function fetchItadId(io: UpstreamIO, appid: number): Promise<Validated<{ itadId: string }>> {
  const itadId = await resolveItadId(io, appid);
  return itadId ? { status: "ok", data: { itadId } } : { status: "not_found" };
}
const itadPricesSchema = z.array(
  z.object({
    id: z.string().uuid(),
    historyLow: z.object({ y1: optionalItadPrice }).partial().nullable().optional().catch(null),
    deals: z
      .array(
        z.object({
          shop: z.object({ id: z.number().int(), name: z.string().max(64).optional().catch(undefined) }),
          price: optionalItadPrice,
          storeLow: optionalItadPrice,
          flag: z.string().max(4).nullable().optional().catch(null),
        }),
      )
      .optional()
      .catch([]),
  }),
);

/**
 * ITAD data for Steam apps, looked up by Steam AppID ("app/{appid}"): ITAD's
 * game ids first, then current prices at every store with their lows.
 * Two ITAD calls per 200 apps.
 *
 * @returns null when ITAD could not be reached (the rows simply have no lows).
 * @throws only quota or throttling errors, so the engine serves stale data.
 */
export async function fetchItadPrices(
  io: UpstreamIO,
  appids: readonly number[],
  countryCode: string,
): Promise<Map<number, ItadAppPrices> | null> {
  const out = new Map<number, ItadAppPrices>();
  try {
    const idByAppid = new Map<number, string>();
    await mapWithConcurrency(chunk([...new Set(appids)], 200), 2, async (batch) => {
      const found = itadIdsBySteamIdSchema.parse(
        await io.itad("idsBySteamId", { body: batch.map((appid) => `app/${appid}`) }),
      );
      for (const [shopId, itadId] of Object.entries(found)) {
        const appid = appidFromShopId(shopId);
        if (appid && itadId) idByAppid.set(appid, itadId);
      }
    });
    // Recorded for the single-game plans (expanded rows): they skip their lookup.
    if (idByAppid.size > 0) io.itadIds?.remember(idByAppid);
    const appidById = new Map([...idByAppid].map(([appid, id]) => [id, appid]));
    await mapWithConcurrency(chunk([...idByAppid.values()], 200), 2, async (batch) => {
      // No shop filter: every store's current price, for the comparison.
      const prices = itadPricesSchema.parse(
        await io.itad("prices", { query: { country: countryCode.toUpperCase() }, body: batch }),
      );
      for (const entry of prices) {
        const appid = appidById.get(entry.id);
        if (!appid) continue;
        const deals = entry.deals ?? [];
        const steam = deals.find((deal) => deal.shop.id === ITAD_STEAM_SHOP_ID);
        let cheapest: CheaperElsewhere | null = null;
        for (const deal of deals) {
          if (deal.shop.id === ITAD_STEAM_SHOP_ID || !deal.price || !deal.shop.name) continue;
          if (!cheapest || deal.price.cents < cheapest.price) {
            cheapest = { shop: deal.shop.name, price: deal.price.cents };
          }
        }
        out.set(appid, {
          steamLow: steam?.storeLow?.cents ?? null,
          yearLowAnyStore: entry.historyLow?.y1?.cents ?? null,
          steamFlag: steam?.flag ?? null,
          cheapestElsewhere: cheapest,
        });
      }
    });
  } catch (err) {
    const kind = (err as { kind?: unknown } | null)?.kind;
    if (kind === "quota_denied" || kind === "throttled") throw err;
    return null;
  }
  return out;
}

// =============================================================================
// One game's prices at every store (ITAD), for the expanded Deals row
// =============================================================================

export interface ItadStorePrice {
  readonly shop: string;
  readonly isSteam: boolean;
  /** Current price there, in cents. */
  readonly price: number;
  readonly regular: number;
  readonly cut: number;
  /** Lowest price ever recorded at that store, in cents. */
  readonly storeLow: number | null;
  /**
   * Link to this game's page at that store, as ITAD gives it (usually an ITAD
   * redirect that may carry an affiliate tag). https only; null if absent.
   */
  readonly url: string | null;
}

export interface ItadAppPriceData {
  readonly currency: string | null;
  /** Every store ITAD tracks with a current price, cheapest first (at most 20). */
  readonly stores: readonly ItadStorePrice[];
  /** Lowest price ever at any store ITAD tracks. */
  readonly allTimeLow: number | null;
  readonly yearLow: number | null;
  readonly threeMonthLow: number | null;
  /** Lowest price ever at the Steam store. */
  readonly steamLow: number | null;
}

const itadAppPricesSchema = z.array(
  z.object({
    id: z.string().uuid(),
    historyLow: z
      .object({ all: optionalItadPrice, y1: optionalItadPrice, m3: optionalItadPrice })
      .partial()
      .nullable()
      .optional()
      .catch(null),
    // Checked one by one below, so one odd store does not hide the rest.
    deals: z.array(z.unknown()).optional().catch([]),
  }),
);

const itadStoreDealSchema = z.object({
  shop: z.object({ id: z.number().int(), name: z.string().trim().min(1).max(64) }),
  price: itadPriceSchema,
  regular: optionalItadPrice,
  cut: z.number().int().min(0).max(100).optional().catch(0),
  storeLow: optionalItadPrice,
  url: z.string().max(2048).optional().catch(undefined),
});

/** Only absolute https links leave our pages; anything else is dropped. */
export function safeStoreUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Two ITAD calls: Steam AppID -> ITAD id, then that game's prices everywhere. */
export async function fetchItadAppPrices(
  io: UpstreamIO,
  appid: number,
  countryCode: string,
): Promise<Validated<ItadAppPriceData>> {
  const itadId = await resolveItadId(io, appid);
  if (!itadId) return { status: "not_found" };

  const entries = itadAppPricesSchema.parse(
    await io.itad("prices", { query: { country: countryCode.toUpperCase() }, body: [itadId] }),
  );
  const entry = entries.find((candidate) => candidate.id === itadId);
  if (!entry) return { status: "not_found" };

  const deals = (entry.deals ?? []).flatMap((raw) => {
    const parsed = itadStoreDealSchema.safeParse(raw);
    return parsed.success ? [parsed.data] : [];
  });
  const byShop = new Map<string, ItadStorePrice>();
  for (const deal of deals) {
    const current = byShop.get(deal.shop.name);
    if (current && current.price <= deal.price.cents) continue;
    byShop.set(deal.shop.name, {
      shop: deal.shop.name,
      isSteam: deal.shop.id === ITAD_STEAM_SHOP_ID,
      price: deal.price.cents,
      regular: deal.regular?.cents ?? deal.price.cents,
      cut: deal.cut ?? 0,
      storeLow: deal.storeLow?.cents ?? null,
      url: deal.shop.id === ITAD_STEAM_SHOP_ID ? `https://store.steampowered.com/app/${appid}/` : safeStoreUrl(deal.url),
    });
  }
  const stores = [...byShop.values()].sort((a, b) => a.price - b.price).slice(0, 20);
  const steam = stores.find((store) => store.isSteam);
  return {
    status: "ok",
    data: {
      currency: deals[0]?.price.currency ?? null,
      stores,
      allTimeLow: entry.historyLow?.all?.cents ?? null,
      yearLow: entry.historyLow?.y1?.cents ?? null,
      threeMonthLow: entry.historyLow?.m3?.cents ?? null,
      steamLow: steam?.storeLow ?? null,
    },
  };
}

// =============================================================================
// Steam wishlist
// =============================================================================

export interface SteamWishlistEntry {
  readonly appid: number;
  /** Steam's ordering: 1 is the user's top pick. 0 means not ranked. */
  readonly priority: number;
  readonly addedAt: string | null;
}

export interface SteamWishlistIds {
  /**
   * "empty_or_private": Steam answers a private wishlist and an empty one
   * identically, so the two cannot be told apart.
   */
  readonly status: "ok" | "empty_or_private";
  readonly items: readonly SteamWishlistEntry[];
}

/** Larger wishlists are cut to the user's top-ranked entries. */
export const STEAM_WISHLIST_LIMIT = 500;

const getWishlistSchema = z.object({
  response: z.object({
    items: z
      .array(
        z.object({
          appid: z.number().int().positive(),
          priority: z.number().int().nonnegative().optional().catch(0),
          date_added: z.number().int().nonnegative().optional().catch(undefined),
        }),
      )
      .optional(),
  }),
});

function parseWishlist(raw: unknown): SteamWishlistIds {
  const items = getWishlistSchema.parse(raw).response.items ?? [];
  if (items.length === 0) return { status: "empty_or_private", items: [] };
  const entries = items
    .filter((item) => item.appid <= 9_999_999)
    .map((item) => ({
      appid: item.appid,
      priority: item.priority ?? 0,
      addedAt: item.date_added ? new Date(item.date_added * 1000).toISOString() : null,
    }))
    // Ranked first (1, 2, 3...), unranked (0) last.
    .sort((a, b) => (a.priority || Infinity) - (b.priority || Infinity) || a.appid - b.appid)
    .slice(0, STEAM_WISHLIST_LIMIT);
  return { status: "ok", items: entries };
}

export async function fetchSteamWishlistIds(
  io: UpstreamIO,
  steamid: string,
): Promise<Validated<SteamWishlistIds>> {
  return { status: "ok", data: parseWishlist(await io.webApi("GetWishlist", { steamid })) };
}

export interface WishlistLows {
  /** Lowest price ever recorded at the Steam store, in cents. */
  readonly steamLow: number | null;
  /** Lowest price at any store ITAD tracks in the past year, in cents. */
  readonly yearLowAnyStore: number | null;
}

export interface WishlistViewData {
  readonly steam: SteamWishlistIds;
  /** Store data for Steam-wishlisted and locally watched apps. */
  readonly apps: readonly StoreItem[];
  /** Keyed by appid (as a string, for JSON). Empty when ITAD is not configured. */
  readonly lows: Readonly<Record<string, WishlistLows>>;
  readonly lowsAvailable: boolean;
}

/**
 * Everything the wishlist page needs in one cached entry: the Steam wishlist,
 * store data for it and for locally watched games, and ITAD historical lows.
 */
export async function fetchWishlistView(
  io: UpstreamIO,
  steamid: string,
  localAppidsCsv: string,
  countryCode: string,
): Promise<Validated<WishlistViewData>> {
  const steam = parseWishlist(await io.webApi("GetWishlist", { steamid }));
  const local = localAppidsCsv
    .split(",")
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
  const appids = [...new Set([...steam.items.map((item) => item.appid), ...local])];

  // Store data and ITAD prices both need only the AppIDs, so they run at the
  // same time (v1.9; before, ITAD waited for GetItems to finish).
  const [{ items }, prices] = await Promise.all([
    fetchStoreItems(io, appids, countryCode),
    isItadConfigured() && appids.length > 0
      ? fetchItadPrices(io, appids, countryCode)
      : Promise.resolve(null),
  ]);

  const lows: Record<string, WishlistLows> = {};
  for (const [appid, found] of prices ?? []) {
    lows[String(appid)] = { steamLow: found.steamLow, yearLowAnyStore: found.yearLowAnyStore };
  }

  return {
    status: "ok",
    data: { steam, apps: [...items.values()], lows, lowsAvailable: Object.keys(lows).length > 0 },
  };
}

// =============================================================================
// Price history (ITAD)
// =============================================================================

export interface ItadHistoryData {
  readonly currency: string | null;
  /** Lowest Steam price per UTC day with a price change, oldest first. */
  readonly points: readonly PricePoint[];
  /** The most recent logged Steam price: the price right now. */
  readonly latestFinal: number | null;
}

const itadHistorySchema = z.array(
  z.object({
    timestamp: z.string().datetime({ offset: true }),
    shop: z.object({ id: z.number().int() }),
    deal: z.object({
      price: itadPriceSchema,
      regular: itadPriceSchema,
      cut: z.number().int().min(0).max(100),
    }),
  }),
);

/** Turns ITAD's change log into one point per day. Exported for tests. */
export function historyToPoints(raw: unknown): ItadHistoryData {
  const entries = itadHistorySchema
    .parse(raw)
    .filter((entry) => entry.shop.id === ITAD_STEAM_SHOP_ID);
  const byDay = new Map<string, PricePoint>();
  for (const entry of entries) {
    const date = new Date(entry.timestamp).toISOString().slice(0, 10);
    const point: PricePoint = {
      date,
      final: entry.deal.price.cents,
      initial: entry.deal.regular.cents,
      discountPercent: entry.deal.cut,
    };
    const current = byDay.get(date);
    if (!current || point.final < current.final) byDay.set(date, point);
  }
  const newest = entries.reduce<(typeof entries)[number] | null>(
    (best, entry) => (!best || Date.parse(entry.timestamp) > Date.parse(best.timestamp) ? entry : best),
    null,
  );
  return {
    currency: newest?.deal.price.currency ?? null,
    points: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
    latestFinal: newest?.deal.price.cents ?? null,
  };
}

/** Earlier than any Steam store price (the store opened in 2003). */
export const ITAD_HISTORY_SINCE = "2003-01-01T00:00:00Z";

export async function fetchItadHistory(
  io: UpstreamIO,
  appid: number,
  countryCode: string,
): Promise<Validated<ItadHistoryData>> {
  const itadId = await resolveItadId(io, appid);
  if (!itadId) return { status: "not_found" };

  const history = historyToPoints(
    await io.itad("history", {
      query: {
        id: itadId,
        country: countryCode.toUpperCase(),
        shops: String(ITAD_STEAM_SHOP_ID),
        // Always send `since`. Without it ITAD returned only about the last
        // three months; this date predates Steam's store, so every logged
        // price change comes back, back to the game's first Steam price.
        since: ITAD_HISTORY_SINCE,
      },
    }),
  );
  return { status: "ok", data: history };
}
