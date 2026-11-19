import "server-only";

/**
 * lib/library.ts
 *
 * Builds GET /api/library/store's answer (v1.10): store data for the signed-in
 * user's library, with tag names attached.
 *
 * 1. The owned games come from the cached library (no request input is
 *    trusted for which games to cover).
 * 2. At most LIBRARY_STORE_MAX_APPS games are covered, most played first, so
 *    the games people look at have data even in a huge library.
 * 3. Library store data and the shared tag list load in parallel. If tag
 *    names fail, the answer still carries prices and dates, with no tags.
 */
import type { LibraryGameStore, LibraryStorePayload } from "@/lib/library-view";
import type { CachedResult } from "@/lib/steam/cached-fetch";
import {
  getLibraryStore,
  getOwnedGames,
  getSteamTags,
  type EndpointContext,
  type OwnedGame,
} from "@/lib/steam/endpoints";
import { LIBRARY_STORE_MAX_APPS } from "@/lib/steam/library-store";

/** Which appids get store data: most played first, then newest appid. Exported for tests. */
export function pickLibraryAppids(games: readonly OwnedGame[]): number[] {
  return [...games]
    .sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || b.appid - a.appid)
    .slice(0, LIBRARY_STORE_MAX_APPS)
    .map((game) => game.appid);
}

export async function buildLibraryStore(
  steamid: string,
  context: EndpointContext,
): Promise<CachedResult<LibraryStorePayload>> {
  const owned = await getOwnedGames(steamid, context);
  if (owned.status !== "ok") return owned;

  const appids = pickLibraryAppids(owned.data.games);
  const total = owned.data.games.length;
  if (appids.length === 0) {
    return { status: "ok", data: { items: {}, covered: 0, total, tagsAvailable: true }, meta: owned.meta };
  }

  const [store, tags] = await Promise.all([
    getLibraryStore(steamid, appids, "us", context),
    // Names are a nicety: without them the answer still has prices and dates.
    getSteamTags(context).catch(() => null),
  ]);
  if (store.status !== "ok") return store;

  const names = tags?.status === "ok" ? tags.data.names : null;
  const items: Record<string, LibraryGameStore> = {};
  for (const [appid, entry] of Object.entries(store.data.items)) {
    items[appid] = {
      headerImage: entry.headerImage,
      releaseDate: entry.releaseDate,
      comingSoon: entry.comingSoon,
      isFree: entry.isFree,
      priceFinal: entry.priceFinal,
      priceInitial: entry.priceInitial,
      discountPercent: entry.discountPercent,
      tags: names
        ? entry.tagids.map((id) => names[String(id)]).filter((name): name is string => Boolean(name))
        : [],
    };
  }
  return {
    status: "ok",
    data: { items, covered: appids.length, total, tagsAvailable: names !== null },
    meta: store.meta,
  };
}
