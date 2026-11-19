/**
 * lib/game-insights.ts
 *
 * Everything shown about one game in an expanded Deals row or on a Wishlist
 * card, gathered from cached sources in parallel:
 *
 *   Live players        GetNumberOfCurrentPlayers   10 min fresh, Web API
 *   Developer, publisher,
 *   franchise, tag ids  GetItems (one app)          1 day fresh, Web API
 *   Tag names           IStoreService/GetTagList    1 week fresh, one entry for all
 *   Genres, descriptors Storefront appdetails       1 day fresh, Storefront
 *   Prices everywhere   ITAD lookup + prices        1 hour fresh, ITAD
 *   Player peaks        ITAD games/info players     1 hour fresh, ITAD (v1.12)
 *
 * Two modes:
 *
 *   "full"  An expanded Deals row or the game page. Adds ITAD's prices at
 *           every store, Steam's review summary, and ITAD's 24-hour and
 *           all-time player peaks.
 *   "card"  A Wishlist card coming into view. No ITAD store prices; the card
 *           already shows its lows.
 *
 * Both fetch appdetails (genres, descriptors) when it is not cached. It is the
 * only source of Steam's genres, and the Storefront allows about 150 calls
 * per 5 minutes, so the costs are bounded: each game is fetched at most once
 * a day for all users together (24-hour cache), Wishlist cards only ask once
 * they scroll into view, every call goes through the Storefront quota gate,
 * and when that budget is spent the card simply shows no genres.
 *
 * Each source is optional. One failing removes only its own section, listed
 * in `unavailable`; this module only throws when the app id is invalid.
 */
import "server-only";

import { isItadConfigured } from "@/lib/itad/client";
import type { CacheMeta, CachedResult } from "@/lib/steam/cached-fetch";
import type { ReviewSummary } from "@/lib/steam/reviews";
import {
  getAppDetails,
  getAppReviews,
  getAppStoreMeta,
  getCurrentPlayers,
  getItadAppPrices,
  getItadPlayers,
  getSteamTags,
  type AppDetails,
  type EndpointContext,
  type ItadAppPriceData,
} from "@/lib/steam/endpoints";
import { DEFAULT_COUNTRY_CODE, appIdSchema } from "@/lib/validation";

export type InsightsMode = "full" | "card";

export type InsightsSection = "players" | "metadata" | "genres" | "prices" | "reviews" | "playerPeaks";

/**
 * IsThereAnyDeal's player peaks for one game, tracked from Steam (v1.12).
 * A field is null when ITAD has no figure for it (common for niche games).
 * Counts only: ITAD's player stats carry no dates, so no peak date is shown
 * (the v1.12.1 date from our own recordings was removed in v1.12.2).
 */
export interface PlayerPeaks {
  /** Highest concurrent players in the last 24 hours (ITAD `players.day`). */
  readonly day: number | null;
  /** Highest concurrent players ITAD has seen (ITAD `players.peak`). */
  readonly allTime: number | null;
}

export interface GameInsights {
  readonly appid: number;
  /** From the store, when known. */
  readonly name: string | null;
  readonly storeUrl: string;
  readonly developers: readonly string[];
  readonly publishers: readonly string[];
  readonly franchises: readonly string[];
  /** Steam genres, e.g. "RPG", "Action". */
  readonly genres: readonly string[];
  /** Steam descriptors (store categories), e.g. "Single-player", "Steam Achievements". */
  readonly descriptors: readonly string[];
  /** Most-voted user tags, e.g. "Open World". */
  readonly tags: readonly string[];
  /** Null when Steam has no count for this app. */
  readonly players: { readonly count: number; readonly asOf: string } | null;
  /** Prices at every store ITAD tracks. Only in "full" mode with an ITAD key. */
  readonly prices: ItadAppPriceData | null;
  /**
   * Steam's review summary: label ("Very Positive"), share positive and the
   * total count, as on the store page (Steam purchasers, every language).
   * Only in "full" mode (v1.11); null in "card" mode or when Steam has none.
   */
  readonly reviews: ReviewSummary | null;
  /**
   * ITAD's player peaks. Only in "full" mode with an ITAD key; null in "card"
   * mode, without a key, or when ITAD could not be asked (then "playerPeaks"
   * is in `unavailable`). Never estimated.
   */
  readonly playerPeaks: PlayerPeaks | null;
  /** Sections that could not be loaded this time (shown as "unavailable"). */
  readonly unavailable: readonly InsightsSection[];
}

const MAX_DESCRIPTORS = 12;

/**
 * Trimmed, non-empty, first occurrence only (case-insensitive). Steam can list
 * one descriptor under several category ids, e.g. "DualSense Controller
 * Support" twice.
 */
function unique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const item = raw.trim();
    const key = item.toLowerCase();
    if (!item || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export async function buildGameInsights(
  appid: number | string,
  mode: InsightsMode,
  context: EndpointContext,
): Promise<CachedResult<GameInsights>> {
  const id = appIdSchema.parse(appid);
  const cc = DEFAULT_COUNTRY_CODE;
  const wantPrices = mode === "full" && isItadConfigured();

  const wantReviews = mode === "full";
  const wantPeaks = mode === "full" && isItadConfigured();

  const [players, meta, tags, details, prices, reviews, peaks] = await Promise.allSettled([
    getCurrentPlayers(id, context),
    getAppStoreMeta(id, cc, context),
    getSteamTags(context),
    getAppDetails(id, cc, context).then((r) => (r.status === "ok" ? r.data : null)),
    wantPrices ? getItadAppPrices(id, cc, context) : Promise.resolve(null),
    // Cached per app for 3 days and shared with the Deals review fill-in.
    wantReviews ? getAppReviews(id, context) : Promise.resolve(null),
    // ITAD player stats, cached per app for an hour and shared by everyone.
    wantPeaks ? getItadPlayers(id, context) : Promise.resolve(null),
  ]);

  const unavailable: InsightsSection[] = [];
  const metas: CacheMeta[] = [];
  const ok = <T,>(settled: PromiseSettledResult<CachedResult<T> | null>, section: InsightsSection): T | null => {
    if (settled.status === "rejected") {
      unavailable.push(section);
      return null;
    }
    if (!settled.value) return null;
    metas.push(settled.value.meta);
    return settled.value.status === "ok" ? settled.value.data : null;
  };

  const playerData = ok(players, "players");
  const metaData = ok(meta, "metadata");
  const tagNames = tags.status === "fulfilled" && tags.value.status === "ok" ? tags.value.data.names : {};
  const app: AppDetails | null = details.status === "fulfilled" ? details.value : null;
  if (details.status === "rejected") unavailable.push("genres");
  const priceData = wantPrices ? ok(prices, "prices") : null;
  const reviewData = wantReviews ? ok(reviews, "reviews") : null;
  // ITAD answered: its figures, or N/A for a game it has no counts for.
  const peakData = wantPeaks ? ok(peaks, "playerPeaks") : null;
  const playerPeaks: PlayerPeaks | null =
    wantPeaks && peaks.status === "fulfilled" ? { day: peakData?.day ?? null, allTime: peakData?.peak ?? null } : null;

  const meta0: CacheMeta =
    metas.length > 0
      ? metas.reduce((a, b) => (Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b))
      : { source: "cache", fetchedAt: new Date().toISOString(), stale: false };

  return {
    status: "ok",
    data: {
      appid: id,
      name: app?.name ?? null,
      storeUrl: `https://store.steampowered.com/app/${id}/`,
      developers: unique(metaData?.developers.length ? metaData.developers : (app?.developers ?? [])),
      publishers: unique(metaData?.publishers.length ? metaData.publishers : (app?.publishers ?? [])),
      franchises: unique(metaData?.franchises ?? []),
      genres: unique(app?.genres ?? []),
      descriptors: unique(app?.categories ?? []).slice(0, MAX_DESCRIPTORS),
      tags: unique(
        (metaData?.tagids ?? []).flatMap((tagid) => {
          const name = tagNames[String(tagid)];
          return name ? [name] : [];
        }),
      ),
      players:
        playerData && players.status === "fulfilled"
          ? { count: playerData.count, asOf: players.value.meta.fetchedAt }
          : null,
      prices: priceData,
      reviews: reviewData,
      playerPeaks,
      unavailable,
    },
    meta: { ...meta0, stale: metas.some((m) => m.stale) },
  };
}
