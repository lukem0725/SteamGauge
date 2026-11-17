/**
 * lib/steam/specials.ts
 *
 * Parser for the Storefront `featuredcategories` response ("Specials" and
 * "Top sellers"). Pure: no I/O and no imports of the cache engine, so both
 * lib/steam/endpoints.ts and lib/steam/composites.ts can use it.
 */
import { z } from "zod";

import type { Validated } from "./cached-fetch";

/** An https URL, or null when the field is missing or is anything else. */
const httpsUrlOrNull = z.string().max(2048).regex(/^https:\/\/\S+$/).nullable().catch(null);

/** A non-negative integer, or undefined when missing or malformed. */
const optionalCount = z.number().int().nonnegative().optional().catch(undefined);

function unixSecondsToIso(seconds: number | undefined): string | null {
  return seconds && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

export interface SaleItem {
  readonly appid: number;
  readonly name: string;
  readonly headerImage: string | null;
  /** ISO 4217 code, e.g. "USD". */
  readonly currency: string;
  /** Prices are in the currency's minor unit (cents). */
  readonly originalPrice: number;
  readonly finalPrice: number;
  /** 1 to 100. */
  readonly discountPercent: number;
  /** When the discount ends, if Steam says. */
  readonly discountEndsAt: string | null;
}

export interface StoreSpecials {
  /** Discounted games Steam is currently featuring, in Steam's order, no duplicates. */
  readonly items: readonly SaleItem[];
}

/** Steam's item type for a single app. Packages (1) and bundles (2) are skipped. */
const FEATURED_ITEM_TYPE_APP = 0;
const MAX_SALE_ITEMS = 30;

const rawFeaturedItemSchema = z.object({
  id: z.number().int().positive(),
  type: z.number().int().optional().catch(undefined),
  name: z.string().min(1).max(512),
  discounted: z.boolean().optional().catch(undefined),
  discount_percent: z.number().int().min(0).max(100).optional().catch(undefined),
  original_price: z.number().int().nonnegative().nullable().optional().catch(undefined),
  final_price: z.number().int().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  header_image: httpsUrlOrNull,
  large_capsule_image: httpsUrlOrNull,
  discount_expiration: optionalCount,
});

const rawFeaturedCategorySchema = z
  .object({ items: z.array(z.unknown()) })
  .optional()
  .catch(undefined);

const rawFeaturedCategoriesSchema = z.object({
  specials: rawFeaturedCategorySchema,
  top_sellers: rawFeaturedCategorySchema,
});

export function parseStoreSpecials(raw: unknown): Validated<StoreSpecials> {
  const { specials, top_sellers } = rawFeaturedCategoriesSchema.parse(raw);

  // If neither category is present this is not the response we asked for.
  if (!specials && !top_sellers) {
    throw new Error("Storefront response has no specials or top_sellers category");
  }

  // "Trending and discounted": Steam's specials first, then any top seller
  // that happens to be on sale.
  const seen = new Set<number>();
  const items: SaleItem[] = [];
  for (const entry of [...(specials?.items ?? []), ...(top_sellers?.items ?? [])]) {
    if (items.length >= MAX_SALE_ITEMS) break;
    const parsed = rawFeaturedItemSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;

    const original = item.original_price ?? 0;
    const percent = item.discount_percent ?? 0;
    const isApp = item.type === undefined || item.type === FEATURED_ITEM_TYPE_APP;
    const isOnSale = percent > 0 && original > item.final_price;
    if (!isApp || !isOnSale || item.id > 9_999_999 || seen.has(item.id)) continue;

    seen.add(item.id);
    items.push({
      appid: item.id,
      name: item.name.trim(),
      headerImage: item.header_image ?? item.large_capsule_image,
      currency: item.currency,
      originalPrice: original,
      finalPrice: item.final_price,
      discountPercent: percent,
      discountEndsAt: unixSecondsToIso(item.discount_expiration),
    });
  }

  return { status: "ok", data: { items } };
}

