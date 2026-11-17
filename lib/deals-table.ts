/**
 * lib/deals-table.ts
 *
 * The deals table's rules: price badges, filters, sorting and paging. Pure
 * functions with no I/O, imported by the server (badges, in lib/deals.ts) and
 * by the browser (filters and sorting, in components/deals-view.tsx), so both
 * sides always agree.
 */
import type { DealRecord } from "@/lib/steam/composites";

// =============================================================================
// Types
// =============================================================================

export interface DealBadges {
  /** A new all-time low at the Steam store. */
  readonly historicalLow: boolean;
  /** Equal to the previous all-time low at the Steam store. */
  readonly matchingLow: boolean;
  /** At or below the lowest price at any tracked store in the past year. */
  readonly yearLow: boolean;
}

export interface DealRow extends DealRecord {
  /** Null when the user's library is private or could not be loaded. */
  readonly owned: boolean | null;
  /** On the user's Steam wishlist. */
  readonly wished: boolean;
  /** On the user's SteamGauge watchlist. */
  readonly watched: boolean;
  readonly badges: DealBadges;
}

export interface DealsPayload {
  readonly rows: readonly DealRow[];
  /**
   * "steam":    Steam's discounted top sellers (the normal case).
   * "featured": Steam's featured specials only, because the sale query failed.
   */
  readonly source: "steam" | "featured";
  /** False without IsThereAnyDeal data: no badges, so the deal status filter is off. */
  readonly lowsAvailable: boolean;
  readonly ownershipKnown: boolean;
  /** "empty_or_private" or "unavailable" when the Steam wishlist could not be read. */
  readonly steamWishlist: "ok" | "empty_or_private" | "unavailable";
  /** Rows with no Steam rating or release data (shown with a dash). */
  readonly missingStoreData: number;
  /** True when some deal pages could not be loaded and the list is shorter. */
  readonly partial: boolean;
  /**
   * Rows whose Steam review totals are still being looked up. They fill in
   * over the next few loads (lib/steam/review-backfill.ts).
   */
  readonly reviewsPending: number;
}

export type DealStatusFilter = "any" | "historical" | "matching" | "year";
export type OwnedFilter = "include" | "exclude" | "only";

export interface DealFilters {
  readonly status: DealStatusFilter;
  readonly owned: OwnedFilter;
  /** Only games on the Steam wishlist or the SteamGauge watchlist. */
  readonly wishedOnly: boolean;
  /** Hide DLC and other non-game items. */
  readonly gamesOnly: boolean;
  /**
   * Hide titles with fewer than STEAM_MIN_REVIEWS_FOR_SCORE reviews, the
   * point below which Steam itself shows no score. Rows whose review data is
   * still loading, and unreleased games (which cannot have reviews), are kept.
   */
  readonly hideUnrated: boolean;
  /** Dollars. Null means no bound. */
  readonly priceMin: number | null;
  readonly priceMax: number | null;
  /** Percent positive, 0-100. 0 means off. */
  readonly minRating: number;
  readonly minReviews: number;
  /** Percent, 0-100. 0 means off. */
  readonly minDiscount: number;
}

export const DEFAULT_FILTERS: DealFilters = {
  status: "any",
  owned: "include",
  wishedOnly: false,
  gamesOnly: true,
  hideUnrated: true,
  priceMin: null,
  priceMax: null,
  minRating: 0,
  minReviews: 0,
  minDiscount: 0,
};

/** Below this many reviews Steam shows "Need more user reviews" instead of a score. */
export const STEAM_MIN_REVIEWS_FOR_SCORE = 10;

/**
 * "score" is the default "Top deals" order (dealScore). "reviews" is total
 * review count. Neither has its own column; both are offered in the
 * "Sort by" menu.
 */
export type SortKey = "score" | "name" | "discount" | "price" | "rating" | "reviews" | "release" | "ends";
export type SortDirection = "asc" | "desc";

export const DEFAULT_SORT: { readonly key: SortKey; readonly direction: SortDirection } = {
  key: "score",
  direction: "desc",
};

/** The direction a column sorts in when first clicked. */
export const FIRST_DIRECTION: Readonly<Record<SortKey, SortDirection>> = {
  score: "desc",
  reviews: "desc",
  name: "asc",
  discount: "desc",
  price: "asc",
  rating: "desc",
  release: "desc",
  ends: "asc",
};

export const PAGE_SIZES = [25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

// =============================================================================
// Badges
// =============================================================================

/**
 * Badge rules, from IsThereAnyDeal's numbers:
 *
 *   Historical low  price below the Steam all-time low, or equal to it with
 *                   ITAD's flag "N" (read here as "new historical low").
 *   Matching low    price equal to the Steam all-time low, otherwise.
 *   1-year low      price at or below the lowest price at any store ITAD
 *                   tracks over the past 12 months.
 *
 * ITAD does not document its flag values or whether its stored low already
 * includes the current deal. Both readings give the same answer here except
 * for a brand-new low, where the flag decides. Confirm "N" against ITAD.
 */
export function computeBadges(deal: DealRecord): DealBadges {
  const low = deal.steamLow;
  const historicalLow = low !== null && (deal.price < low || (deal.price === low && deal.itadFlag === "N"));
  const matchingLow = low !== null && deal.price === low && !historicalLow;
  const yearLow = deal.yearLowAnyStore !== null && deal.price <= deal.yearLowAnyStore;
  return { historicalLow, matchingLow, yearLow };
}

// =============================================================================
// Top deals score
// =============================================================================

/**
 * The "Top deals" order:
 *
 *   score = log10(total Steam reviews) x discount%
 *
 * so a well-known game on a real sale outranks an obscure one at the same
 * discount. Examples:
 *
 *   200,000 reviews, 50% off  ->  5.30 x 50 = 265
 *   100,000 reviews, 50% off  ->  5.00 x 50 = 250
 *     1,000 reviews, 90% off  ->  3.00 x 90 = 270
 *        50 reviews, 90% off  ->  1.70 x 90 = 153
 *
 * Null (sorted last) when the review count is unknown or below Steam's own
 * scoring threshold, so shovelware with no reviews never leads the table.
 */
export function dealScore(
  row: Pick<DealRecord, "reviewCount" | "discountPercent">,
): number | null {
  if (row.reviewCount === null || row.reviewCount < STEAM_MIN_REVIEWS_FOR_SCORE) return null;
  const discount = Math.min(100, Math.max(0, row.discountPercent));
  return Math.log10(row.reviewCount) * discount;
}

// =============================================================================
// Filtering
// =============================================================================

/**
 * Applies every filter. Rows without a Steam rating are dropped only when a
 * minimum rating or minimum review count is set: an unknown rating cannot be
 * shown to pass.
 */
export function filterDeals(rows: readonly DealRow[], filters: DealFilters): DealRow[] {
  const minCents = filters.priceMin !== null ? Math.round(filters.priceMin * 100) : null;
  const maxCents = filters.priceMax !== null ? Math.round(filters.priceMax * 100) : null;

  return rows.filter((row) => {
    if (filters.gamesOnly && row.type !== "game") return false;
    if (
      filters.hideUnrated &&
      !row.comingSoon &&
      row.reviewCount !== null &&
      row.reviewCount < STEAM_MIN_REVIEWS_FOR_SCORE
    ) {
      return false;
    }

    if (filters.status === "historical" && !row.badges.historicalLow) return false;
    if (filters.status === "matching" && !row.badges.matchingLow) return false;
    if (filters.status === "year" && !row.badges.yearLow) return false;

    // Unknown ownership never matches "only" and never gets excluded.
    if (filters.owned === "only" && row.owned !== true) return false;
    if (filters.owned === "exclude" && row.owned === true) return false;
    if (filters.wishedOnly && !row.wished && !row.watched) return false;

    if (minCents !== null && row.price < minCents) return false;
    if (maxCents !== null && row.price > maxCents) return false;

    if (filters.minRating > 0 && (row.reviewPercent === null || row.reviewPercent < filters.minRating)) {
      return false;
    }
    if (filters.minReviews > 0 && (row.reviewCount === null || row.reviewCount < filters.minReviews)) {
      return false;
    }
    if (filters.minDiscount > 0 && row.discountPercent < filters.minDiscount) return false;
    return true;
  });
}

/** How many filters differ from the defaults. Shown on the mobile toggle. */
export function countActiveFilters(filters: DealFilters): number {
  return (Object.keys(DEFAULT_FILTERS) as (keyof DealFilters)[]).filter(
    (key) => filters[key] !== DEFAULT_FILTERS[key],
  ).length;
}

// =============================================================================
// Sorting and paging
// =============================================================================

function sortValue(row: DealRow, key: SortKey): number | string | null {
  switch (key) {
    case "score":
      return dealScore(row);
    case "reviews":
      return row.reviewCount;
    case "name":
      return row.name.toLocaleLowerCase("en");
    case "discount":
      return row.discountPercent;
    case "price":
      return row.price;
    case "rating":
      return row.reviewPercent;
    case "release":
      return row.releaseDate;
    case "ends":
      return row.saleEndsAt ? Date.parse(row.saleEndsAt) : null;
  }
}

/**
 * Stable sort. Missing values (no rating, no release date, no end time) go
 * last in both directions, so they never crowd the top of a list. Ties are
 * broken by review count, then name.
 */
export function sortDeals(
  rows: readonly DealRow[],
  key: SortKey,
  direction: SortDirection,
): DealRow[] {
  const sign = direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, key) }))
    .sort((a, b) => {
      if (a.value === null && b.value !== null) return 1;
      if (b.value === null && a.value !== null) return -1;
      if (a.value !== null && b.value !== null && a.value !== b.value) {
        return (a.value < b.value ? -1 : 1) * sign;
      }
      const reviews = (b.row.reviewCount ?? -1) - (a.row.reviewCount ?? -1);
      if ((key === "rating" || key === "score" || key === "discount") && reviews !== 0) return reviews;
      return a.row.name.localeCompare(b.row.name, "en") || a.index - b.index;
    })
    .map((entry) => entry.row);
}

export interface PageSlice<T> {
  readonly items: readonly T[];
  /** 1-based, clamped to the available pages. */
  readonly page: number;
  readonly pageCount: number;
  /** 1-based positions of the first and last item shown; 0 when empty. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
}

export function paginate<T>(rows: readonly T[], page: number, size: number): PageSlice<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const start = (current - 1) * size;
  const items = rows.slice(start, start + size);
  return {
    items,
    page: current,
    pageCount,
    from: items.length > 0 ? start + 1 : 0,
    to: start + items.length,
    total,
  };
}
