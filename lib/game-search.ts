/**
 * lib/game-search.ts
 *
 * Global search: the dropdown under the search box in the top bar.
 *
 *   1. Steam's store search for the normalised query (cached for everyone
 *      for a day; lib/steam/search.ts), with art, release year and price.
 *   2. SteamGauge's own catalog (steam_apps) through the typo-tolerant
 *      search_steam_apps function (migration 0003), for misspellings Steam's
 *      search does not forgive.
 *   3. Both lists are merged, de-duplicated and ranked with fuzzyScore
 *      (lib/title-search.ts) blended with Steam's own order.
 *
 * Every Steam result is added to steam_apps (name only, in the background),
 * so the catalog, and with it typo tolerance, grows with use.
 *
 * Either source may fail; the other still answers. Only when both fail does
 * this throw.
 */
import "server-only";

import { CachedFetchError, type CacheMeta, type CachedResult } from "@/lib/steam/cached-fetch";
import { getStoreSearch, type EndpointContext, type SteamSearchHit } from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { fuzzyScore, normalizeTitle } from "@/lib/title-search";

/** Rows shown in the dropdown. */
export const SEARCH_RESULTS = 8;
/** Below this, a catalog-only match is too far from what was typed. */
const MIN_CATALOG_SCORE = 0.45;

export interface SearchResult {
  readonly appid: number;
  readonly name: string;
  /** 231 x 87 capsule art. */
  readonly image: string;
  readonly releaseYear: number | null;
  readonly comingSoon: boolean;
  readonly isFree: boolean;
  /** Current price in cents (USD). Null when unknown or not sold. */
  readonly price: number | null;
  readonly regular: number | null;
  readonly discountPercent: number;
}

export interface SearchPayload {
  /** The query as matched (normalised). */
  readonly query: string;
  readonly results: readonly SearchResult[];
  /** False when Steam's search could not be reached; results are catalog only. */
  readonly steamAvailable: boolean;
}

const capsuleFor = (appid: number) =>
  `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${appid}/capsule_231x87.jpg`;

interface CatalogRow {
  readonly appid: number;
  readonly name: string;
  readonly score: number;
}

async function searchCatalog(term: string): Promise<CatalogRow[]> {
  if (term.length < 3) return [];
  const { data, error } = await getSupabaseAdmin().rpc("search_steam_apps", { p_query: term, p_limit: 10 });
  // Thrown without the database's message, so nothing internal reaches a log.
  if (error) throw new Error("catalog search failed");
  if (!Array.isArray(data)) return [];
  return (data as unknown[]).flatMap((row) => {
    const r = row as { appid?: unknown; name?: unknown; score?: unknown };
    return Number.isInteger(r.appid) && typeof r.name === "string"
      ? [{ appid: r.appid as number, name: r.name, score: typeof r.score === "number" ? r.score : 0 }]
      : [];
  });
}

export async function searchGames(
  rawQuery: string,
  context: EndpointContext,
): Promise<CachedResult<SearchPayload>> {
  const term = normalizeTitle(rawQuery).slice(0, 64).trim();
  const now: CacheMeta = { source: "cache", fetchedAt: new Date().toISOString(), stale: false };
  if (term.length < 2) return { status: "ok", data: { query: term, results: [], steamAvailable: true }, meta: now };

  const [steam, catalog] = await Promise.allSettled([getStoreSearch(term, undefined, context), searchCatalog(term)]);
  const steamHits: readonly SteamSearchHit[] =
    steam.status === "fulfilled" && steam.value.status === "ok" ? steam.value.data.hits : [];
  const relaxed = steam.status === "fulfilled" && steam.value.status === "ok" && steam.value.data.relaxed;
  const catalogRows = catalog.status === "fulfilled" ? catalog.value : [];
  if (steam.status === "rejected" && catalog.status === "rejected") {
    throw steam.reason instanceof CachedFetchError ? steam.reason : new CachedFetchError("internal", "storeSearch");
  }

  const ranked = new Map<number, { result: SearchResult; score: number }>();
  steamHits.forEach((hit, index) => {
    const match = fuzzyScore(term, hit.name);
    // After a relaxed retry (one word only), keep only results close to the full query.
    if (relaxed && match < MIN_CATALOG_SCORE) return;
    ranked.set(hit.appid, {
      score: 0.6 * match + 0.4 * (1 - index / Math.max(steamHits.length, 1)),
      result: {
        appid: hit.appid,
        name: hit.name,
        image: hit.image ?? capsuleFor(hit.appid),
        releaseYear: hit.releaseYear,
        comingSoon: hit.comingSoon,
        isFree: hit.isFree,
        price: hit.price,
        regular: hit.regular,
        discountPercent: hit.discountPercent,
      },
    });
  });
  for (const row of catalogRows) {
    if (ranked.has(row.appid)) continue;
    const match = fuzzyScore(term, row.name);
    if (Math.max(match, row.score) < MIN_CATALOG_SCORE) continue;
    ranked.set(row.appid, {
      score: 0.6 * Math.max(match, row.score),
      result: {
        appid: row.appid,
        name: row.name,
        image: capsuleFor(row.appid),
        releaseYear: null,
        comingSoon: false,
        isFree: false,
        price: null,
        regular: null,
        discountPercent: 0,
      },
    });
  }

  const results = [...ranked.values()]
    .sort((a, b) => b.score - a.score || a.result.name.localeCompare(b.result.name))
    .slice(0, SEARCH_RESULTS)
    .map((entry) => entry.result);

  // Grow the catalog with what Steam found (names only; other columns keep
  // whatever app details already wrote). Never delays or fails the answer.
  if (steamHits.length > 0) {
    const rows = steamHits.map((hit) => ({ appid: hit.appid, name: hit.name, updated_at: new Date().toISOString() }));
    const save = Promise.resolve(
      getSupabaseAdmin().from("steam_apps").upsert(rows, { onConflict: "appid" }),
    ).then(
      () => undefined,
      () => undefined,
    );
    if (context.waitUntil) context.waitUntil(save);
  }

  return {
    status: "ok",
    data: { query: term, results, steamAvailable: steam.status === "fulfilled" },
    meta: steam.status === "fulfilled" ? steam.value.meta : now,
  };
}
