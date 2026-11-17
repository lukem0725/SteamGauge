/**
 * lib/deals.ts
 *
 * Builds the deals table for one signed-in user.
 *
 * Steam first, SteamDB style. The pool is Steam's own answer to "which of
 * the global top 1,000 sellers are discounted right now", from
 * IStoreQueryService/Query: 5 cached pages of 200, each already carrying
 * Steam's price, discount, sale end, release date and review totals.
 *
 * IsThereAnyDeal only enriches that pool, looked up by Steam AppID: the
 * Steam all-time low, the 1-year low at any store, and the cheapest current
 * price at another store. Without ITAD_API_KEY the table is the same minus
 * those (no price badges).
 *
 * If Steam's query fails for every page, the table falls back to Steam's
 * featured specials (a few dozen games), enriched the same way.
 *
 * Steam review totals come from the batched GetItems call. Rows it left
 * without them are filled from the per-app review cache and a few bounded
 * GetAppReviews lookups per request (lib/steam/review-backfill.ts), so the
 * "Top deals" order and the review filters have data to work with.
 *
 * Then, per user: owned (library), wished (Steam wishlist) and watched
 * (SteamGauge watchlist) flags. Every Steam and ITAD read goes through the
 * cached-fetch pipeline; the shared deal pages are fetched about once an hour
 * for all users together.
 *
 * Filtering, sorting and paging happen in the browser (lib/deals-table.ts),
 * so changing a filter costs no request.
 */
import "server-only";

import { computeBadges, type DealRow, type DealsPayload } from "@/lib/deals-table";
import { CachedFetchError, type CacheMeta, type CachedResult } from "@/lib/steam/cached-fetch";
import { backfillReviews } from "@/lib/steam/review-backfill";
import {
  getDealsFallback,
  getSalePage,
  getOwnedGames,
  getSteamWishlistIds,
  type DealRecord,
  type DealsPageData,
  type EndpointContext,
} from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { DEFAULT_COUNTRY_CODE } from "@/lib/validation";

/** Sale pages of 200. 5 pages cover the whole top-1,000-sellers pool. */
export const SALE_PAGES = 5;

/**
 * @throws CachedFetchError if no deal page at all can be served. Missing
 *         library, wishlist or watchlist data only removes those flags.
 */
export async function buildDeals(
  session: { readonly steamid: string },
  context: Pick<EndpointContext, "waitUntil"> = {},
): Promise<CachedResult<DealsPayload>> {
  const ctx: EndpointContext = { session, waitUntil: context.waitUntil };

  const [pages, owned, wishlist, watched] = await Promise.all([
    loadDealPages(ctx),
    loadOwned(session.steamid, ctx),
    loadSteamWishlist(session.steamid, ctx),
    loadWatched(session.steamid),
  ]);

  const seen = new Set<number>();
  const unique = pages.deals.filter((deal) => !seen.has(deal.appid) && seen.add(deal.appid));

  // Games before DLC, otherwise Steam's own order, so the rows most likely
  // to be looked at are filled in first. Array.prototype.sort is stable.
  const reviewOrder = [...unique].sort(
    (a, b) => Number(b.type === "game") - Number(a.type === "game"),
  );
  const reviews = await backfillReviews(reviewOrder, ctx);

  const rows: DealRow[] = [];
  for (const record of unique) {
    const summary = reviews.summaries.get(record.appid);
    const deal: DealRecord = summary
      ? {
          ...record,
          reviewCount: summary.count,
          reviewPercent: summary.percent,
          reviewLabel: summary.label,
        }
      : record;
    rows.push({
      ...deal,
      owned: owned ? owned.has(deal.appid) : null,
      wished: wishlist.appids.has(deal.appid),
      watched: watched.has(deal.appid),
      badges: computeBadges(deal),
    });
  }

  return {
    status: "ok",
    data: {
      rows,
      source: pages.source,
      lowsAvailable: pages.lowsAvailable,
      ownershipKnown: owned !== null,
      steamWishlist: wishlist.status,
      missingStoreData: pages.missingStoreData,
      partial: pages.partial,
      reviewsPending: reviews.pending,
    },
    meta: pages.meta,
  };
}

// =============================================================================
// Loaders
// =============================================================================

interface LoadedPages {
  readonly source: "steam" | "featured";
  readonly lowsAvailable: boolean;
  readonly deals: readonly DealRecord[];
  readonly missingStoreData: number;
  readonly partial: boolean;
  readonly meta: CacheMeta;
}

async function loadDealPages(ctx: EndpointContext): Promise<LoadedPages> {
  const settled = await Promise.allSettled(
    Array.from({ length: SALE_PAGES }, (_, page) => getSalePage(page, DEFAULT_COUNTRY_CODE, ctx)),
  );
  const results = settled.flatMap((entry) => (entry.status === "fulfilled" ? [entry.value] : []));
  if (results.some((result) => result.status === "ok" && result.data.deals.length > 0)) {
    if (results.length < settled.length) logDeals("pages_partial", settled.length - results.length);
    return fromResults(results, results.length < settled.length, "steam");
  }

  // Steam's sale query failed (or returned nothing): use its featured specials.
  logDeals("sale_query_unavailable");
  try {
    const fallback = await getDealsFallback(DEFAULT_COUNTRY_CODE, ctx);
    return fromResults([fallback], false, "featured");
  } catch (err) {
    const first = settled.find((entry) => entry.status === "rejected");
    if (err instanceof CachedFetchError) throw err;
    throw first && first.status === "rejected" && first.reason instanceof CachedFetchError
      ? first.reason
      : new CachedFetchError("internal", "salePage");
  }
}

function fromResults(
  results: readonly CachedResult<DealsPageData>[],
  partial: boolean,
  source: "steam" | "featured",
): LoadedPages {
  const ok = results.flatMap((result) => (result.status === "ok" ? [result.data] : []));
  const deals = ok.flatMap((page) => page.deals);
  const missingStoreData = ok.reduce((sum, page) => sum + page.missingStoreData, 0);
  const lowsAvailable = ok.some((page) => page.lowsAvailable);
  // Report the oldest page, and "stale" if any page is being refreshed.
  const metas = results.map((result) => result.meta);
  const oldest = metas.reduce((a, b) => (Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b));
  const meta: CacheMeta = {
    source: metas.every((m) => m.source === "steam") ? "steam" : "cache",
    fetchedAt: oldest.fetchedAt,
    stale: metas.some((m) => m.stale),
  };
  return { source, lowsAvailable, deals, missingStoreData, partial, meta };
}

async function loadOwned(steamid: string, ctx: EndpointContext): Promise<ReadonlySet<number> | null> {
  try {
    const library = await getOwnedGames(steamid, ctx);
    return library.status === "ok" ? new Set(library.data.games.map((game) => game.appid)) : null;
  } catch {
    logDeals("library_unavailable");
    return null;
  }
}

async function loadSteamWishlist(
  steamid: string,
  ctx: EndpointContext,
): Promise<{ status: DealsPayload["steamWishlist"]; appids: ReadonlySet<number> }> {
  try {
    const wishlist = await getSteamWishlistIds(steamid, ctx);
    if (wishlist.status !== "ok") return { status: "unavailable", appids: new Set() };
    return {
      status: wishlist.data.status,
      appids: new Set(wishlist.data.items.map((item) => item.appid)),
    };
  } catch {
    logDeals("steam_wishlist_unavailable");
    return { status: "unavailable", appids: new Set() };
  }
}

/** The user's SteamGauge watchlist, always filtered by the session's SteamID. */
async function loadWatched(steamid: string): Promise<ReadonlySet<number>> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("tracked_apps")
      .select("appid")
      .eq("user_steamid", steamid)
      .limit(200);
    if (error) throw new Error("tracked apps read failed");
    const rows: unknown[] = Array.isArray(data) ? data : [];
    return new Set(
      rows
        .map((row) => (row as { appid?: unknown } | null)?.appid)
        .filter((appid): appid is number => Number.isInteger(appid)),
    );
  } catch {
    logDeals("wishlist_unavailable");
    return new Set();
  }
}

/** Fixed labels only: no SteamID, cache key, or raw error message. */
function logDeals(event: string, count?: number): void {
  console.error(JSON.stringify({ scope: "deals", event, ...(count !== undefined ? { count } : {}) }));
}
