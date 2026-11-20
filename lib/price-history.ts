/**
 * lib/price-history.ts
 *
 * Price history for the wishlist chart, from one of two sources:
 *
 *   "itad"   IsThereAnyDeal's multi-year log of Steam price changes
 *            (lib/steam/composites.ts, fetchItadHistory). Used whenever an
 *            ITAD key is configured and ITAD knows the game.
 *   "local"  SteamGauge's own record, below. The fallback.
 *
 * SteamGauge's own record of store prices over time:
 *
 * Steam does not publish historical prices. Instead, every time a price is
 * fetched from Steam through the cached-fetch pipeline, the endpoint wrappers
 * call `recordPriceObservation`, which stores the lowest price seen per app,
 * per country, per UTC day (table `price_history`, migration 0002).
 *
 * Consequences worth remembering wherever this is shown:
 *   - History starts when SteamGauge first saw the app, not when the app was
 *     released. "Lowest recorded" is not "lowest ever".
 *   - A day with no observation has no row. The chart draws the last known
 *     price forward across such gaps.
 */
import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { AppPrice } from "@/lib/steam/endpoints";

// =============================================================================
// Types (also imported, as types only, by client components)
// =============================================================================

export interface PricePoint {
  /** UTC calendar day, "YYYY-MM-DD". */
  readonly date: string;
  /** Lowest price observed that day, in the currency's minor unit (cents). */
  readonly final: number;
  /** The undiscounted price that day. */
  readonly initial: number;
  readonly discountPercent: number;
}

/**
 * "at_low"                The current price is the lowest we have recorded.
 * "above_low"             We have recorded a lower price before.
 * "insufficient_history"  Fewer than MIN_DAYS_FOR_LOW_CLAIM days recorded:
 *                         too little to call anything a historical low.
 * "no_price"              The app has no current price (free or unavailable).
 */
export type LowStatus = "at_low" | "above_low" | "insufficient_history" | "no_price";

export interface PriceHistory {
  readonly appid: number;
  /** Where the points came from. Wording in the UI differs by source. */
  readonly source: "itad" | "local";
  readonly currency: string | null;
  /** Oldest first. At most MAX_HISTORY_DAYS most recent recorded days. */
  readonly points: readonly PricePoint[];
  readonly firstObservedOn: string | null;
  /**
   * Number of points: days with an observation ("local") or days with a
   * price change ("itad").
   */
  readonly observedDays: number;
  /** The lowest recorded price and the most recent day it was seen. */
  readonly lowest: { readonly final: number; readonly date: string } | null;
  /** The current store price used for the comparison, if there is one. */
  readonly currentFinal: number | null;
  readonly lowStatus: LowStatus;
  /**
   * Set (v1.14.1) only when IsThereAnyDeal has this game's full history but
   * could not be read just now, so these points are SteamGauge's own short
   * record standing in. Never cached; the browser asks again.
   */
  readonly pendingFullHistory?: true;
}

// =============================================================================
// Tunables
// =============================================================================

/**
 * A "historical low" claim needs at least this many recorded days. With one
 * or two observations the current price is trivially the lowest on record,
 * and saying so would mislead.
 */
export const MIN_DAYS_FOR_LOW_CLAIM = 7;

/** Rows read per app: the Supabase API's default row cap, about 2.7 years of days. */
const MAX_HISTORY_DAYS = 1000;

// =============================================================================
// Write
// =============================================================================

/**
 * Records that `price` was the store price for `appid` in `countryCode` right
 * now. Keeps the day's lowest. A no-op for apps not yet in `steam_apps`.
 *
 * @throws if the database call fails. Callers on the read path (onRefreshed
 *         hooks) let cachedFetch log and swallow that.
 */
export async function recordPriceObservation(
  appid: number,
  countryCode: string,
  price: AppPrice,
): Promise<void> {
  const { error } = await getSupabaseAdmin().rpc("record_price_observation", {
    p_appid: appid,
    p_cc: countryCode,
    p_currency: price.currency,
    p_price_initial: price.initial,
    p_price_final: price.final,
    p_discount_percent: price.discountPercent,
  });
  if (error) throw new Error("price observation write failed");
}

// =============================================================================
// Read
// =============================================================================

/**
 * @param currentFinal  The current store price in minor units, or null if the
 *                      app has none. Compared against the recorded low.
 * @throws if the database cannot be read.
 */
export async function loadPriceHistory(
  appid: number,
  countryCode: string,
  currentFinal: number | null,
): Promise<PriceHistory> {
  const { data, error } = await getSupabaseAdmin()
    .from("price_history")
    .select("observed_on,currency,price_initial,price_final,discount_percent")
    .eq("appid", appid)
    .eq("cc", countryCode.toLowerCase())
    .order("observed_on", { ascending: false })
    .limit(MAX_HISTORY_DAYS);
  if (error) throw new Error("price history read failed");

  const raw: unknown[] = Array.isArray(data) ? data : [];
  const rows = raw.filter(isHistoryRow).reverse();
  return summarizePriceHistory(
    appid,
    rows.map((row): PricePoint => ({
      date: row.observed_on,
      final: row.price_final,
      initial: row.price_initial,
      discountPercent: row.discount_percent,
    })),
    rows.at(-1)?.currency ?? null,
    currentFinal,
    "local",
  );
}

/** Pure: exported so the rules can be unit-tested without a database. */
export function summarizePriceHistory(
  appid: number,
  points: readonly PricePoint[],
  currency: string | null,
  currentFinal: number | null,
  source: "itad" | "local" = "local",
): PriceHistory {
  let lowest: { final: number; date: string } | null = null;
  for (const point of points) {
    // `<=` keeps the most recent day the low was seen.
    if (!lowest || point.final <= lowest.final) lowest = { final: point.final, date: point.date };
  }

  let lowStatus: LowStatus;
  // ITAD's log covers years, so any history is enough to judge a low. Our own
  // record needs a week before the claim means anything.
  const needed = source === "itad" ? 1 : MIN_DAYS_FOR_LOW_CLAIM;
  if (currentFinal === null) lowStatus = "no_price";
  else if (points.length < needed || !lowest) lowStatus = "insufficient_history";
  else lowStatus = currentFinal <= lowest.final ? "at_low" : "above_low";

  return {
    appid,
    source,
    currency,
    points,
    firstObservedOn: points[0]?.date ?? null,
    observedDays: points.length,
    lowest,
    currentFinal,
    lowStatus,
  };
}

interface HistoryRow {
  observed_on: string;
  currency: string;
  price_initial: number;
  price_final: number;
  discount_percent: number;
}

function isHistoryRow(value: unknown): value is HistoryRow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.observed_on === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(v.observed_on) &&
    typeof v.currency === "string" &&
    Number.isInteger(v.price_initial) &&
    Number.isInteger(v.price_final) &&
    Number.isInteger(v.discount_percent)
  );
}
