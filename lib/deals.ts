/**
 * lib/deals.ts
 *
 * Builds the "Bang for Your Buck" deals ranking for one signed-in user.
 *
 *   1. Trending discounts   getStoreSpecials()   1 Storefront call, shared 1 h
 *   2. The user's library   getOwnedGames()      1 Web API call, cached 1 h
 *   3. Genres               getAppDetails()      per sale item and per sampled
 *                                                backlog game, shared 24 h
 *
 * Every read goes through `cachedFetch`, so the quota governor, leases and
 * stale-while-revalidate all apply. Nothing here talks to Steam directly.
 *
 * Score: cost per hour = sale price / completion time, lower is better. The
 * completion time is SIMULATED (lib/value.ts); there is no real length data
 * source yet, and the payload says so (`lengthIsSimulated`).
 */
import "server-only";

import { CachedFetchError, type CachedResult } from "@/lib/steam/cached-fetch";
import {
  getAppDetails,
  getOwnedGames,
  getStoreSpecials,
  type EndpointContext,
  type SaleItem,
} from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { DEFAULT_COUNTRY_CODE } from "@/lib/validation";
import { costPerHour, rateValue, simulatedHoursToBeat, type ValueLevel } from "@/lib/value";

// =============================================================================
// Types (also imported, as types only, by components/deals-view.tsx)
// =============================================================================

export interface BacklogGenreMatch {
  readonly genre: string;
  /** How many of the user's sampled unplayed games have this genre. */
  readonly unplayedCount: number;
}

export interface Deal {
  /** 1 is the best value. */
  readonly rank: number;
  readonly appid: number;
  readonly name: string;
  readonly headerImage: string | null;
  readonly currency: string;
  /** Prices are in the currency's minor unit (cents). */
  readonly originalPrice: number;
  readonly finalPrice: number;
  readonly discountPercent: number;
  readonly discountEndsAt: string | null;
  /** SIMULATED completion time in hours. */
  readonly estimatedHours: number;
  /** The utility score: finalPrice / estimatedHours, in cents. Lower is better. */
  readonly centsPerHour: number;
  readonly valueLevel: ValueLevel;
  readonly valueLabel: string;
  /** Null when the genres could not be loaded (for example store budget spent). */
  readonly genres: readonly string[] | null;
  /** True if the user already owns this game. */
  readonly owned: boolean;
  /** True if this game is on the user's wishlist. */
  readonly watched: boolean;
  /**
   * Set when the user does not own this game but already has unplayed games
   * in one or more of its genres. Most-crowded genre first.
   */
  readonly backlogMatches: readonly BacklogGenreMatch[] | null;
}

export interface DealsBacklogSummary {
  /**
   * "ok"           Backlog compared against the deals.
   * "private"      The user's game details are private: no warnings possible.
   * "unavailable"  The library could not be loaded right now: no warnings.
   */
  readonly status: "ok" | "private" | "unavailable";
  /** Games with exactly 0 minutes played. */
  readonly unplayedCount: number;
  /** How many of those had their genres checked (capped, see BACKLOG_SAMPLE_LIMIT). */
  readonly analyzedCount: number;
}

export interface DealsPayload {
  readonly deals: readonly Deal[];
  readonly backlog: DealsBacklogSummary;
  /** Always true until a real completion-time source replaces lib/value.ts. */
  readonly lengthIsSimulated: true;
}

// =============================================================================
// Tunables
// =============================================================================

/**
 * At most this many unplayed games have their genres looked up. Each lookup
 * can cost one Storefront call on a cold cache, and that budget is 150 per
 * 5 minutes for the whole app. The sample is the first N by name, the same
 * games the dashboard's backlog deck shows, so the two pages share cache.
 */
const BACKLOG_SAMPLE_LIMIT = 24;

/** Parallel detail lookups. Keeps a cold request quick without a burst. */
const DETAIL_CONCURRENCY = 4;

/** At most this many genres are named in one warning. */
const MAX_MATCHES_PER_DEAL = 3;

/** Store labels that are business models or release states, not genres. */
const NOT_REAL_GENRES = new Set(["free to play", "early access"]);

// =============================================================================
// buildDeals
// =============================================================================

/**
 * @param session  The verified user. Required: the result is personalised.
 * @returns the ranking in our standard envelope. `meta` describes the age of
 *          the sale list itself.
 * @throws CachedFetchError if the sale list cannot be served at all. Missing
 *         library or genre data only degrades the result; it never throws.
 */
export async function buildDeals(
  session: { readonly steamid: string },
  context: Pick<EndpointContext, "waitUntil"> = {},
): Promise<CachedResult<DealsPayload>> {
  const ctx: EndpointContext = { session, waitUntil: context.waitUntil };

  const [specials, library, watchedAppids] = await Promise.all([
    getStoreSpecials(DEFAULT_COUNTRY_CODE, ctx),
    loadLibrary(session.steamid, ctx),
    loadWatchedAppids(session.steamid),
  ]);

  const saleItems: readonly SaleItem[] = specials.status === "ok" ? specials.data.items : [];

  const backlogSample = library.unplayed.slice(0, BACKLOG_SAMPLE_LIMIT);
  const appids = [
    ...new Set([...saleItems.map((item) => item.appid), ...backlogSample.map((g) => g.appid)]),
  ];
  const genresByApp = await loadGenres(appids, ctx);

  // How many sampled unplayed games carry each genre.
  const backlogGenreCounts = new Map<string, BacklogGenreMatch>();
  let analyzedCount = 0;
  for (const game of backlogSample) {
    const genres = genresByApp.get(game.appid);
    if (!genres) continue;
    analyzedCount++;
    for (const genre of genres) {
      const key = genre.toLowerCase();
      const current = backlogGenreCounts.get(key);
      backlogGenreCounts.set(key, { genre, unplayedCount: (current?.unplayedCount ?? 0) + 1 });
    }
  }

  const scored = saleItems.map((item) => {
    const estimatedHours = simulatedHoursToBeat(item.appid);
    const centsPerHour = costPerHour(item.finalPrice, estimatedHours);
    const rating = rateValue(centsPerHour);
    const genres = genresByApp.get(item.appid) ?? null;
    const owned = library.ownedAppids.has(item.appid);

    const matches =
      owned || !genres
        ? []
        : genres
            .map((genre) => backlogGenreCounts.get(genre.toLowerCase()))
            .filter((match): match is BacklogGenreMatch => match !== undefined)
            .sort((a, b) => b.unplayedCount - a.unplayedCount || a.genre.localeCompare(b.genre))
            .slice(0, MAX_MATCHES_PER_DEAL);

    return {
      appid: item.appid,
      name: item.name,
      headerImage: item.headerImage,
      currency: item.currency,
      originalPrice: item.originalPrice,
      finalPrice: item.finalPrice,
      discountPercent: item.discountPercent,
      discountEndsAt: item.discountEndsAt,
      estimatedHours,
      centsPerHour,
      valueLevel: rating.level,
      valueLabel: rating.label,
      genres,
      owned,
      watched: watchedAppids.has(item.appid),
      backlogMatches: matches.length > 0 ? matches : null,
    };
  });

  // Best value first. Ties: the deeper discount, then name, for a stable order.
  scored.sort(
    (a, b) =>
      a.centsPerHour - b.centsPerHour ||
      b.discountPercent - a.discountPercent ||
      a.name.localeCompare(b.name),
  );

  return {
    status: "ok",
    data: {
      deals: scored.map((deal, index) => ({ rank: index + 1, ...deal })),
      backlog: {
        status: library.status,
        unplayedCount: library.unplayed.length,
        analyzedCount,
      },
      lengthIsSimulated: true,
    },
    meta: specials.meta,
  };
}

// =============================================================================
// Helpers
// =============================================================================

interface LibraryView {
  readonly status: DealsBacklogSummary["status"];
  readonly ownedAppids: ReadonlySet<number>;
  /** Games with 0 minutes played, sorted by name. */
  readonly unplayed: readonly { readonly appid: number; readonly name: string }[];
}

const NO_LIBRARY = { ownedAppids: new Set<number>(), unplayed: [] } as const;

/** The deals list is still useful without the library, so this never throws. */
async function loadLibrary(steamid: string, ctx: EndpointContext): Promise<LibraryView> {
  try {
    const library = await getOwnedGames(steamid, ctx);
    if (library.status !== "ok") return { status: "private", ...NO_LIBRARY };

    return {
      status: "ok",
      ownedAppids: new Set(library.data.games.map((game) => game.appid)),
      unplayed: library.data.games
        .filter((game) => game.playtimeMinutes === 0)
        .map((game) => ({ appid: game.appid, name: game.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (err) {
    logDeals("library_unavailable", err);
    return { status: "unavailable", ...NO_LIBRARY };
  }
}

/**
 * Which apps are on this user's wishlist. One small query, always filtered
 * by the session's SteamID. A failure only hides the "In wishlist" state.
 */
async function loadWatchedAppids(steamid: string): Promise<ReadonlySet<number>> {
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
  } catch (err) {
    logDeals("wishlist_unavailable", err);
    return new Set();
  }
}

/**
 * Genres for each app, through the shared 24-hour app-details cache. An app
 * whose details cannot be loaded (unknown, region-locked, store budget spent)
 * is simply absent from the map.
 */
async function loadGenres(
  appids: readonly number[],
  ctx: EndpointContext,
): Promise<Map<number, readonly string[]>> {
  const result = new Map<number, readonly string[]>();
  let failures = 0;

  await mapWithConcurrency(appids, DETAIL_CONCURRENCY, async (appid) => {
    try {
      const details = await getAppDetails(appid, DEFAULT_COUNTRY_CODE, ctx);
      if (details.status === "ok") {
        result.set(
          appid,
          details.data.genres.filter((genre) => !NOT_REAL_GENRES.has(genre.toLowerCase())),
        );
      }
    } catch {
      failures++;
    }
  });

  if (failures > 0) logDeals("genres_partial", undefined, failures);
  return result;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Fixed labels only: no SteamID, cache key, or raw error message. */
function logDeals(event: string, err?: unknown, count?: number): void {
  console.error(
    JSON.stringify({
      scope: "deals",
      event,
      ...(err !== undefined
        ? {
            label:
              err instanceof CachedFetchError
                ? err.reason
                : err instanceof Error
                  ? err.name
                  : "non_error",
          }
        : {}),
      ...(count !== undefined ? { count } : {}),
    }),
  );
}
