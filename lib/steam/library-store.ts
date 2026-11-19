/**
 * lib/steam/library-store.ts
 *
 * Store data for a user's whole library, for the Dashboard's sorting,
 * filtering and detailed cards (v1.10): header art, release date, current
 * price and the most-voted tags of every owned game.
 *
 * One IStoreBrowseService/GetItems call per 50 games (Web API budget, not the
 * tight Storefront one), 3 at a time, through the normal quota gate. The
 * result is one per-user cache entry (resource `libraryStore`).
 *
 * Tag ids are stored; names are attached when the route answers, from the
 * shared tag list (resource `steamTags`).
 */
import type { UpstreamIO, Validated } from "./cached-fetch";
import { fetchStoreItems } from "./store-items";

/**
 * Libraries can hold thousands of games. Store data is requested for at most
 * this many (40 GetItems calls); the caller picks the most-played first.
 */
export const LIBRARY_STORE_MAX_APPS = 2000;

/** Top tags kept per game. Steam's own genre labels are among them. */
export const LIBRARY_TAGS_PER_GAME = 5;

export interface LibraryStoreEntry {
  /** 460 x 215 header art. */
  readonly headerImage: string;
  /** "YYYY-MM-DD" (UTC), or null. */
  readonly releaseDate: string | null;
  readonly comingSoon: boolean;
  readonly isFree: boolean;
  /** Current US price in cents (after any discount), or null when not sold. */
  readonly priceFinal: number | null;
  readonly priceInitial: number | null;
  readonly discountPercent: number;
  /** Steam tag ids, most-voted first. */
  readonly tagids: readonly number[];
}

export interface LibraryStoreData {
  /** Keyed by appid (as a string, for JSON). Missing: Steam had nothing. */
  readonly items: Readonly<Record<string, LibraryStoreEntry>>;
  /** How many appids were asked about. */
  readonly requested: number;
  /** GetItems batches that failed; their games simply have no entry. */
  readonly failedBatches: number;
}

export async function fetchLibraryStore(
  io: UpstreamIO,
  appids: readonly number[],
  countryCode: string,
): Promise<Validated<LibraryStoreData>> {
  const { items, failedBatches } = await fetchStoreItems(io, appids, countryCode, {
    tagCount: LIBRARY_TAGS_PER_GAME,
  });
  const out: Record<string, LibraryStoreEntry> = {};
  for (const [appid, item] of items) {
    out[String(appid)] = {
      headerImage: item.headerImage,
      releaseDate: item.releaseDate,
      comingSoon: item.comingSoon,
      isFree: item.isFree,
      priceFinal: item.isFree ? 0 : item.priceFinal,
      priceInitial: item.isFree ? 0 : item.priceInitial,
      discountPercent: item.discountPercent,
      tagids: (item.tagids ?? []).slice(0, LIBRARY_TAGS_PER_GAME),
    };
  }
  return { status: "ok", data: { items: out, requested: appids.length, failedBatches } };
}
