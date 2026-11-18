/**
 * lib/steam/search.ts
 *
 * Steam store search for SteamGauge's global search box.
 *
 *   1. Storefront /api/storesearch with the user's words (Steam's own search
 *      relevance; good at partial titles).
 *   2. If that finds nothing and the query has several words, one retry with
 *      the longest word, so one misspelled word does not sink the search.
 *   3. IStoreBrowseService/GetItems for the top results: capsule art, release
 *      date and the current price with its discount (one Web API call).
 *
 * The whole answer is one cache entry per normalised query, shared by every
 * user (lib/steam/ttl.ts: storeSearch). Ranking against SteamGauge's own
 * catalog happens later, in lib/game-search.ts.
 */
import { z } from "zod";

import type { UpstreamIO, Validated } from "./cached-fetch";
import { fetchStoreItems } from "./store-items";

/** Results kept from Steam per query. */
export const STEAM_SEARCH_LIMIT = 10;

export interface SteamSearchHit {
  readonly appid: number;
  readonly name: string;
  /** 231 x 87 capsule art. */
  readonly image: string | null;
  readonly releaseYear: number | null;
  readonly comingSoon: boolean;
  readonly isFree: boolean;
  /** Current price in cents (USD), null when not sold or free. */
  readonly price: number | null;
  readonly regular: number | null;
  readonly discountPercent: number;
}

export interface SteamSearchData {
  readonly hits: readonly SteamSearchHit[];
  /** True when the plain query found nothing and the longest word was used. */
  readonly relaxed: boolean;
}

const storeSearchSchema = z.object({
  total: z.number().int().nonnegative().optional().catch(undefined),
  items: z
    .array(
      z
        .object({
          type: z.string().max(16).optional().catch(undefined),
          id: z.number().int().positive().max(9_999_999),
          name: z.string().trim().min(1).max(256),
          tiny_image: z.string().max(512).optional().catch(undefined),
        })
        .passthrough(),
    )
    .catch([]),
});

/** Steam's search response -> apps only, in Steam's order, de-duplicated. */
export function parseStoreSearch(raw: unknown): { appid: number; name: string; image: string | null }[] {
  const parsed = storeSearchSchema.parse(raw);
  const seen = new Set<number>();
  const out: { appid: number; name: string; image: string | null }[] = [];
  for (const item of parsed.items) {
    if ((item.type ?? "app") !== "app" || seen.has(item.id)) continue;
    seen.add(item.id);
    const image = item.tiny_image && /^https:\/\/[\w.-]+\.(steamstatic|akamaihd)\.(com|net)\//.test(item.tiny_image)
      ? item.tiny_image
      : null;
    out.push({ appid: item.id, name: item.name, image });
    if (out.length >= STEAM_SEARCH_LIMIT) break;
  }
  return out;
}

export async function fetchStoreSearch(
  io: UpstreamIO,
  term: string,
  countryCode: string,
): Promise<Validated<SteamSearchData>> {
  const search = async (words: string) =>
    parseStoreSearch(await io.store("storesearch", { term: words, l: "english", cc: countryCode.toUpperCase() }));

  let found = await search(term);
  let relaxed = false;
  const words = term.split(/\s+/).filter(Boolean);
  if (found.length === 0 && words.length > 1) {
    const longest = [...words].sort((a, b) => b.length - a.length)[0]!;
    if (longest.length >= 3) {
      found = await search(longest);
      relaxed = true;
    }
  }
  if (found.length === 0) return { status: "ok", data: { hits: [], relaxed } };

  const { items } = await fetchStoreItems(io, found.map((hit) => hit.appid), countryCode);
  const hits = found.map((hit): SteamSearchHit => {
    const store = items.get(hit.appid);
    const year = store?.releaseDate ? Number(store.releaseDate.slice(0, 4)) : NaN;
    return {
      appid: hit.appid,
      name: store?.name ?? hit.name,
      image: store?.capsuleImage ?? hit.image,
      releaseYear: Number.isInteger(year) ? year : null,
      comingSoon: store?.comingSoon ?? false,
      isFree: store?.isFree ?? false,
      price: store?.isFree ? null : (store?.priceFinal ?? null),
      regular: store?.isFree ? null : (store?.priceInitial ?? null),
      discountPercent: store?.discountPercent ?? 0,
    };
  });
  return { status: "ok", data: { hits, relaxed } };
}
