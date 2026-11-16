/**
 * lib/wishlist.ts
 *
 * The personal watchlist: which apps a user tracks (`tracked_apps`) and what
 * they cost right now.
 *
 * Security: every function takes the SteamID from the verified session and
 * every query filters by it. There is no parameter through which one user
 * could read or change another user's list. Row Level Security does not help
 * here (the admin client bypasses it), so this filter is the access control.
 *
 * Data flow: catalog data and prices are read through the cached-fetch
 * pipeline (getAppDetails, getAppPrice). Only the list itself is ours.
 */
import "server-only";

import type { CacheMeta, CachedResult } from "@/lib/steam/cached-fetch";
import {
  getAppDetails,
  getAppPrice,
  upsertCatalogEntry,
  type AppPrice,
  type EndpointContext,
} from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { DEFAULT_COUNTRY_CODE, type AddToWishlistInput } from "@/lib/validation";

// =============================================================================
// Types (also imported, as types only, by components/wishlist-view.tsx)
// =============================================================================

export interface WishlistItem {
  readonly appid: number;
  readonly name: string;
  readonly headerImage: string | null;
  readonly note: string | null;
  readonly addedAt: string;
  /**
   * "priced"       `price` is set. Check `price.discountPercent` for a sale.
   * "free"         The game is free; there is no price to track.
   * "unavailable"  The price could not be loaded right now.
   */
  readonly priceStatus: "priced" | "free" | "unavailable";
  readonly price: AppPrice | null;
}

export interface WishlistPayload {
  readonly items: readonly WishlistItem[];
  /** The most a user may track. */
  readonly limit: number;
}

export type AddResult =
  | { readonly kind: "added"; readonly appid: number }
  | { readonly kind: "app_not_found" }
  | { readonly kind: "wishlist_full" };

// =============================================================================
// Tunables
// =============================================================================

/**
 * Each tracked app costs a Storefront price lookup when its 3-hour cache
 * entry expires. The cap keeps one user's list from dominating that budget.
 */
export const WISHLIST_LIMIT = 50;

const PRICE_CONCURRENCY = 4;

type Session = { readonly steamid: string };

// =============================================================================
// Read
// =============================================================================

/**
 * The user's tracked apps, newest first, each with its current price.
 *
 * `meta` summarises price freshness across the list: `fetchedAt` is the
 * oldest price shown, `stale` is true if any price is being refreshed.
 *
 * @throws if the database cannot be read. A price that cannot be loaded only
 *         marks that one item "unavailable".
 */
export async function listWishlist(
  session: Session,
  context: Pick<EndpointContext, "waitUntil"> = {},
): Promise<CachedResult<WishlistPayload>> {
  const db = getSupabaseAdmin();
  const ctx: EndpointContext = { session, waitUntil: context.waitUntil };

  const tracked = await db
    .from("tracked_apps")
    .select("appid,note,created_at")
    .eq("user_steamid", session.steamid)
    .order("created_at", { ascending: false })
    .limit(WISHLIST_LIMIT);
  if (tracked.error) throw new Error("wishlist read failed");

  const rows = asArray(tracked.data).filter(isTrackedRow);
  if (rows.length === 0) {
    return {
      status: "ok",
      data: { items: [], limit: WISHLIST_LIMIT },
      meta: { source: "cache", fetchedAt: new Date().toISOString(), stale: false },
    };
  }

  const catalog = await db
    .from("steam_apps")
    .select("appid,name,header_image,is_free")
    .in(
      "appid",
      rows.map((row) => row.appid),
    );
  if (catalog.error) throw new Error("catalog read failed");
  const apps = new Map<number, CatalogRow>();
  for (const app of asArray(catalog.data).filter(isCatalogRow)) {
    apps.set(app.appid, app);
  }

  const prices = new Map<number, { price: AppPrice | null; meta: CacheMeta }>();
  await mapWithConcurrency(rows, PRICE_CONCURRENCY, async (row) => {
    try {
      const result = await getAppPrice(row.appid, DEFAULT_COUNTRY_CODE, ctx);
      if (result.status === "ok") prices.set(row.appid, { price: result.data.price, meta: result.meta });
    } catch {
      // Left out of the map: shown as "unavailable".
    }
  });

  const items: WishlistItem[] = rows.map((row) => {
    const app = apps.get(row.appid);
    const priced = prices.get(row.appid);
    const price = priced?.price ?? null;
    return {
      appid: row.appid,
      name: app?.name ?? `App ${row.appid}`,
      headerImage: app?.header_image ?? null,
      note: row.note,
      addedAt: row.created_at,
      // A successful lookup with no price means the game is free here.
      priceStatus: price ? "priced" : priced ? "free" : "unavailable",
      price,
    };
  });

  return { status: "ok", data: { items, limit: WISHLIST_LIMIT }, meta: summarizeMeta(prices) };
}

function summarizeMeta(
  prices: ReadonlyMap<number, { price: AppPrice | null; meta: CacheMeta }>,
): CacheMeta {
  const metas = [...prices.values()].map((entry) => entry.meta);
  if (metas.length === 0) {
    return { source: "cache", fetchedAt: new Date().toISOString(), stale: false };
  }
  const oldest = metas.reduce((a, b) => (Date.parse(a.fetchedAt) <= Date.parse(b.fetchedAt) ? a : b));
  return {
    source: metas.every((meta) => meta.source === "steam") ? "steam" : "cache",
    fetchedAt: oldest.fetchedAt,
    stale: metas.some((meta) => meta.stale),
  };
}

// =============================================================================
// Write
// =============================================================================

/**
 * Adds an app to the user's list, or updates its note if already there.
 *
 * The app must exist on Steam: its details are loaded (from cache when
 * possible) and its `steam_apps` row is ensured first, which the foreign key
 * on `tracked_apps.appid` requires.
 *
 * @throws CachedFetchError if the app is not cached and Steam cannot be asked.
 * @throws if the database write fails.
 */
export async function addToWishlist(
  session: Session,
  input: AddToWishlistInput,
  context: Pick<EndpointContext, "waitUntil"> = {},
): Promise<AddResult> {
  const db = getSupabaseAdmin();

  const existing = await db
    .from("tracked_apps")
    .select("appid")
    .eq("user_steamid", session.steamid)
    .limit(WISHLIST_LIMIT + 1);
  if (existing.error) throw new Error("wishlist read failed");
  const current = asArray(existing.data) as { appid?: unknown }[];
  const alreadyTracked = current.some((row) => row.appid === input.appid);
  if (!alreadyTracked && current.length >= WISHLIST_LIMIT) return { kind: "wishlist_full" };

  const details = await getAppDetails(input.appid, DEFAULT_COUNTRY_CODE, {
    session,
    waitUntil: context.waitUntil,
  });
  if (details.status !== "ok") return { kind: "app_not_found" };

  // On a cache hit the catalog hook did not run, so make sure the row exists.
  await upsertCatalogEntry(details.data);

  const row: Record<string, unknown> = { user_steamid: session.steamid, appid: input.appid };
  // Only touch the note when the caller sent one, so re-adding keeps it.
  if (input.note !== undefined) row.note = input.note;

  const write = await db.from("tracked_apps").upsert(row, { onConflict: "user_steamid,appid" });
  if (write.error) throw new Error("wishlist write failed");

  return { kind: "added", appid: input.appid };
}

/** Removes an app from the user's list. Removing one that is not there is fine. */
export async function removeFromWishlist(session: Session, appid: number): Promise<void> {
  const { error } = await getSupabaseAdmin()
    .from("tracked_apps")
    .delete()
    .eq("user_steamid", session.steamid)
    .eq("appid", appid);
  if (error) throw new Error("wishlist delete failed");
}

// =============================================================================
// Helpers
// =============================================================================

interface TrackedRow {
  appid: number;
  note: string | null;
  created_at: string;
}
interface CatalogRow {
  appid: number;
  name: string;
  header_image: string | null;
  is_free: boolean | null;
}

/** Database results are untyped; treat them as unknown until checked. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isTrackedRow(value: unknown): value is TrackedRow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.appid) &&
    (v.note === null || typeof v.note === "string") &&
    typeof v.created_at === "string"
  );
}

function isCatalogRow(value: unknown): value is CatalogRow {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.appid) && typeof v.name === "string";
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
