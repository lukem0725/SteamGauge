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
 *
 * Two modes:
 *
 *   "full"  An expanded Deals row. Adds ITAD's prices at every store.
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
import {
  getAppDetails,
  getAppStoreMeta,
  getCurrentPlayers,
  getItadAppPrices,
  getSteamTags,
  type AppDetails,
  type EndpointContext,
  type ItadAppPriceData,
} from "@/lib/steam/endpoints";
import { DEFAULT_COUNTRY_CODE, appIdSchema } from "@/lib/validation";

export type InsightsMode = "full" | "card";

export type InsightsSection = "players" | "metadata" | "genres" | "prices";

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
  /** Sections that could not be loaded this time (shown as "unavailable"). */
  readonly unavailable: readonly InsightsSection[];
}

const MAX_DESCRIPTORS = 12;

export async function buildGameInsights(
  appid: number | string,
  mode: InsightsMode,
  context: EndpointContext,
): Promise<CachedResult<GameInsights>> {
  const id = appIdSchema.parse(appid);
  const cc = DEFAULT_COUNTRY_CODE;
  const wantPrices = mode === "full" && isItadConfigured();

  const [players, meta, tags, details, prices] = await Promise.allSettled([
    getCurrentPlayers(id, context),
    getAppStoreMeta(id, cc, context),
    getSteamTags(context),
    getAppDetails(id, cc, context).then((r) => (r.status === "ok" ? r.data : null)),
    wantPrices ? getItadAppPrices(id, cc, context) : Promise.resolve(null),
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
      developers: metaData?.developers.length ? metaData.developers : (app?.developers ?? []),
      publishers: metaData?.publishers.length ? metaData.publishers : (app?.publishers ?? []),
      franchises: metaData?.franchises ?? [],
      genres: app?.genres ?? [],
      descriptors: (app?.categories ?? []).slice(0, MAX_DESCRIPTORS),
      tags: (metaData?.tagids ?? []).flatMap((tagid) => {
        const name = tagNames[String(tagid)];
        return name ? [name] : [];
      }),
      players:
        playerData && players.status === "fulfilled"
          ? { count: playerData.count, asOf: players.value.meta.fetchedAt }
          : null,
      prices: priceData,
      unavailable,
    },
    meta: { ...meta0, stale: metas.some((m) => m.stale) },
  };
}
