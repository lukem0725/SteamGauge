/**
 * lib/wishlist-sort.ts
 *
 * Sort orders for the wishlist page. Pure and client-safe: the page re-sorts
 * the list it already has, so changing the order costs no request.
 *
 * In every order, items missing the value being sorted on (no price, no
 * rating, no date) go last, and ties fall back to Steam wishlist order.
 */
import { STEAM_MIN_REVIEWS_FOR_SCORE } from "@/lib/deals-table";
import type { WishlistItem } from "@/lib/wishlist";

export type WishlistSort =
  | "deals"
  | "steam"
  | "added-desc"
  | "added-asc"
  | "title-asc"
  | "title-desc"
  | "price-asc"
  | "price-desc"
  | "discount-desc"
  | "rating-desc";

export const DEFAULT_WISHLIST_SORT: WishlistSort = "deals";

/** In menu order. */
export const WISHLIST_SORTS: readonly { readonly value: WishlistSort; readonly label: string }[] = [
  { value: "deals", label: "On sale first" },
  { value: "steam", label: "Steam wishlist order" },
  { value: "added-desc", label: "Date added: newest" },
  { value: "added-asc", label: "Date added: oldest" },
  { value: "title-asc", label: "Title: A to Z" },
  { value: "title-desc", label: "Title: Z to A" },
  { value: "price-asc", label: "Price: low to high" },
  { value: "price-desc", label: "Price: high to low" },
  { value: "discount-desc", label: "Biggest discount" },
  { value: "rating-desc", label: "Best rated" },
];

export function isWishlistSort(value: unknown): value is WishlistSort {
  return WISHLIST_SORTS.some((option) => option.value === value);
}

/** Current price in cents: 0 for free games, null when there is no price. */
function priceOf(item: WishlistItem): number | null {
  if (item.priceStatus === "free") return 0;
  return item.priceStatus === "priced" && item.price ? item.price.final : null;
}

function discountOf(item: WishlistItem): number {
  return item.priceStatus === "priced" ? (item.price?.discountPercent ?? 0) : 0;
}

function addedMs(item: WishlistItem): number | null {
  if (!item.addedAt) return null;
  const ms = Date.parse(item.addedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Share positive, or null when Steam shows no score (fewer than 10 reviews). */
function ratingOf(item: WishlistItem): number | null {
  if (item.reviewCount !== null && item.reviewCount < STEAM_MIN_REVIEWS_FOR_SCORE) return null;
  return item.reviewPercent;
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Compares two possibly missing values; missing ones always sort last. */
function compareMissingLast<V extends number | string>(
  a: V | null,
  b: V | null,
  direction: 1 | -1,
  compare: (x: V, y: V) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b) * direction;
}

const numeric = (x: number, y: number) => x - y;

/** Returns a new array; the input is not changed. */
export function sortWishlist(items: readonly WishlistItem[], order: WishlistSort): WishlistItem[] {
  const byList = (a: WishlistItem, b: WishlistItem) => a.listOrder - b.listOrder;
  const compare = (a: WishlistItem, b: WishlistItem): number => {
    switch (order) {
      case "deals":
        return (
          Number(discountOf(b) > 0) - Number(discountOf(a) > 0) ||
          discountOf(b) - discountOf(a) ||
          byList(a, b)
        );
      case "steam":
        return byList(a, b);
      case "added-desc":
      case "added-asc":
        return (
          compareMissingLast(addedMs(a), addedMs(b), order === "added-asc" ? 1 : -1, numeric) ||
          byList(a, b)
        );
      case "title-asc":
      case "title-desc":
        return (
          compareMissingLast(a.name, b.name, order === "title-asc" ? 1 : -1, collator.compare) ||
          byList(a, b)
        );
      case "price-asc":
      case "price-desc":
        return (
          compareMissingLast(priceOf(a), priceOf(b), order === "price-asc" ? 1 : -1, numeric) ||
          byList(a, b)
        );
      case "discount-desc":
        return discountOf(b) - discountOf(a) || byList(a, b);
      case "rating-desc":
        return (
          compareMissingLast(ratingOf(a), ratingOf(b), -1, numeric) ||
          (b.reviewCount ?? -1) - (a.reviewCount ?? -1) ||
          byList(a, b)
        );
    }
  };
  return [...items].sort(compare);
}
