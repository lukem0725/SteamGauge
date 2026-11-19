/**
 * lib/steam/store-items.ts
 *
 * Steam store data for many apps at once, from the Web API method
 * IStoreBrowseService/GetItems: name, artwork, release date, Steam review
 * summary, and the current price with its discount end time.
 *
 * IStoreQueryService/Query returns the same StoreItem objects in the same
 * `response.store_items` array, so parseStoreItems reads both.
 *
 * Why this method: it answers up to 50 apps per call on api.steampowered.com,
 * which has a budget of 80,000 calls a day, instead of one Storefront call per
 * app against 150 per 5 minutes. It is also where Steam's review summary now
 * lives: the old store.steampowered.com/appreviews endpoint has redirected to
 * the store front page since October 2026.
 *
 * VERIFY BEFORE LAUNCH: Valve does not document this response. Field names
 * below follow what other projects read from it. Every field is optional
 * here, so a renamed field shows as a dash instead of breaking the page.
 */
import { z } from "zod";

import type { UpstreamIO } from "./cached-fetch";

export interface StoreItem {
  readonly appid: number;
  readonly name: string | null;
  /** From Steam's app type: 0 = game, 4 = DLC. Null when Steam did not say. */
  readonly appType: "game" | "dlc" | "other" | null;
  /** 460 x 215 header artwork. */
  readonly headerImage: string;
  /** 231 x 87 capsule, for dense lists. */
  readonly capsuleImage: string;
  readonly isFree: boolean;
  /** "YYYY-MM-DD" (UTC), or null if Steam gave none. */
  readonly releaseDate: string | null;
  readonly comingSoon: boolean;
  /** Share of positive Steam reviews, 0-100. Null when there are no reviews. */
  readonly reviewPercent: number | null;
  readonly reviewCount: number | null;
  /** Steam's own wording, e.g. "Very Positive". */
  readonly reviewLabel: string | null;
  /** Current US price in cents, or null if not for sale. */
  readonly priceFinal: number | null;
  readonly priceInitial: number | null;
  readonly discountPercent: number;
  /** When the current discount ends (ISO), if Steam says. */
  readonly saleEndsAt: string | null;
  /**
   * Steam tag ids, most-voted first. Present only when the request asked for
   * tags (fetchStoreItems' `tagCount`), so other cached payloads are unchanged.
   */
  readonly tagids?: readonly number[];
}

/** GetItems accepts at most this many ids per call. */
const BATCH_SIZE = 50;
const BATCH_CONCURRENCY = 3;

const ASSET_HOST = "https://shared.akamai.steamstatic.com/store_item_assets/";

const centsSchema = z
  .union([z.number(), z.string().regex(/^\d{1,9}$/).transform(Number)])
  .pipe(z.number().int().nonnegative())
  .optional()
  .catch(undefined);

/**
 * Review totals reach into the hundreds of thousands. Accept a number or a
 * numeric string (64-bit protobuf fields are sent as strings), never a
 * rounded or truncated value.
 */
const countSchema = z
  .union([z.number(), z.string().regex(/^\d{1,12}$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER))
  .optional()
  .catch(undefined);

const rawStoreItemSchema = z.object({
  appid: z.number().int().positive(),
  type: z.number().int().nonnegative().optional().catch(undefined),
  success: z.number().optional().catch(undefined),
  name: z.string().max(512).optional().catch(undefined),
  is_free: z.boolean().optional().catch(undefined),
  release: z
    .object({
      steam_release_date: z.number().int().positive().optional().catch(undefined),
      original_release_date: z.number().int().positive().optional().catch(undefined),
      is_coming_soon: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  reviews: z
    .object({
      summary_filtered: z
        .object({
          review_count: countSchema,
          percent_positive: z
            .union([z.number(), z.string().regex(/^\d{1,3}$/).transform(Number)])
            .pipe(z.number().int().min(0).max(100))
            .optional()
            .catch(undefined),
          review_score_label: z.string().max(64).optional().catch(undefined),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  assets: z
    .object({
      // e.g. "steam/apps/620/${FILENAME}?t=1745363004"
      asset_url_format: z.string().max(256).regex(/^[\w./${}?=&-]+$/).optional().catch(undefined),
      header: z.string().max(128).regex(/^[\w./-]+$/).optional().catch(undefined),
      small_capsule: z.string().max(128).regex(/^[\w./-]+$/).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  // Requested with include_tag_count (v1.10): weighted tags, or bare ids.
  tags: z
    .array(
      z.object({
        tagid: z.number().int().positive(),
        weight: z.number().nonnegative().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
  tagids: z.array(z.number().int().positive()).optional().catch(undefined),
  best_purchase_option: z
    .object({
      final_price_in_cents: centsSchema,
      original_price_in_cents: centsSchema,
      discount_pct: z.number().int().min(0).max(100).optional().catch(undefined),
      active_discounts: z
        .array(
          z.object({
            discount_end_date: z.number().int().positive().optional().catch(undefined),
          }),
        )
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const rawGetItemsSchema = z.object({
  response: z.object({ store_items: z.array(z.unknown()).optional() }),
});

function assetUrl(appid: number, format: string | undefined, file: string | undefined, fallback: string) {
  if (format && file && format.includes("${FILENAME}")) {
    return ASSET_HOST + format.replace("${FILENAME}", file);
  }
  return `${ASSET_HOST}steam/apps/${appid}/${fallback}`;
}

function unixToDay(seconds: number | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : null;
}

/** Parses one GetItems response. Exported for tests. */
export function parseStoreItems(raw: unknown): StoreItem[] {
  const items = rawGetItemsSchema.parse(raw).response.store_items ?? [];
  const out: StoreItem[] = [];
  for (const entry of items) {
    const parsed = rawStoreItemSchema.safeParse(entry);
    // success 1 means found. Anything else (e.g. 42, unknown app) is skipped.
    if (!parsed.success || (parsed.data.success !== undefined && parsed.data.success !== 1)) continue;
    const item = parsed.data;
    const reviews = item.reviews?.summary_filtered;
    const count = reviews?.review_count ?? null;
    const option = item.best_purchase_option;
    const weighted = [...(item.tags ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const tagids = weighted.length > 0 ? weighted.map((tag) => tag.tagid) : (item.tagids ?? []);
    const endDates = (option?.active_discounts ?? [])
      .map((d) => d.discount_end_date)
      .filter((d): d is number => d !== undefined);

    out.push({
      appid: item.appid,
      name: item.name?.trim() || null,
      appType: item.type === undefined ? null : item.type === 0 ? "game" : item.type === 4 ? "dlc" : "other",
      headerImage: assetUrl(item.appid, item.assets?.asset_url_format, item.assets?.header, "header.jpg"),
      capsuleImage: assetUrl(
        item.appid,
        item.assets?.asset_url_format,
        item.assets?.small_capsule,
        "capsule_231x87.jpg",
      ),
      isFree: item.is_free ?? false,
      releaseDate: unixToDay(item.release?.steam_release_date ?? item.release?.original_release_date),
      comingSoon: item.release?.is_coming_soon ?? false,
      // With no reviews Steam reports percent_positive 0. That is not a rating.
      reviewPercent: count && count > 0 ? (reviews?.percent_positive ?? null) : null,
      reviewCount: count,
      reviewLabel: count && count > 0 ? (reviews?.review_score_label ?? null) : null,
      priceFinal: option?.final_price_in_cents ?? null,
      priceInitial: option?.original_price_in_cents ?? option?.final_price_in_cents ?? null,
      discountPercent: option?.discount_pct ?? 0,
      saleEndsAt: endDates.length > 0 ? new Date(Math.min(...endDates) * 1000).toISOString() : null,
      ...(item.tags !== undefined || item.tagids !== undefined ? { tagids: [...new Set(tagids)] } : {}),
    });
  }
  return out;
}

/**
 * Store data for every appid given, in batches of 50. A batch that fails is
 * logged by the caller's engine and simply missing from the result, so one
 * bad batch costs a few rows their ratings, not the whole page.
 */
export async function fetchStoreItems(
  io: UpstreamIO,
  appids: readonly number[],
  countryCode: string,
  /** Also ask for this many top tags per app (v1.10). Default: no tags. */
  options: { readonly tagCount?: number } = {},
): Promise<{ items: Map<number, StoreItem>; failedBatches: number }> {
  const unique = [...new Set(appids)];
  const batches: number[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) batches.push(unique.slice(i, i + BATCH_SIZE));

  const items = new Map<number, StoreItem>();
  let failedBatches = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++] as number[];
        try {
          const raw = await io.webApi("GetItems", {
            input_json: JSON.stringify({
              ids: batch.map((appid) => ({ appid })),
              context: { language: "english", country_code: countryCode.toUpperCase(), steam_realm: 1 },
              data_request: {
                include_basic_info: true,
                include_assets: true,
                include_release: true,
                include_reviews: true,
                include_all_purchase_options: true,
                ...(options.tagCount ? { include_tag_count: options.tagCount } : {}),
              },
            }),
          });
          for (const item of parseStoreItems(raw)) items.set(item.appid, item);
        } catch (err) {
          // Quota refusals and throttling must stop the whole refresh, so the
          // engine can serve stale data and open the breaker.
          if (isBudgetError(err)) throw err;
          failedBatches++;
        }
      }
    }),
  );
  return { items, failedBatches };
}

function isBudgetError(err: unknown): boolean {
  const kind = (err as { kind?: unknown } | null)?.kind;
  return kind === "quota_denied" || kind === "throttled";
}
