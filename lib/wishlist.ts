/**
 * lib/wishlist.ts
 *
 * The wishlist page's data: the user's live Steam wishlist merged with their
 * SteamGauge watchlist (`tracked_apps`).
 *
 *   Steam wishlist   Read from Steam (IWishlistService/GetWishlist) on every
 *                    refresh, about every 30 minutes. Read-only: SteamGauge
 *                    never writes to Steam.
 *   Watchlist        SteamGauge's own list in Supabase, with notes. Adding or
 *                    removing here changes only this list.
 *
 * Security: every function takes the SteamID from the verified session and
 * every query filters by it. There is no parameter through which one user
 * could read or change another user's list. Row Level Security does not help
 * here (the admin client bypasses it), so this filter is the access control.
 *
 * Data flow: Steam and IsThereAnyDeal are read through the cached-fetch
 * pipeline (getWishlistView, getAppDetails). Only the watchlist is ours.
 */
import "server-only";

import { recordPriceObservation } from "@/lib/price-history";
import { CachedFetchError, type CachedResult } from "@/lib/steam/cached-fetch";
import { backfillReviews } from "@/lib/steam/review-backfill";
import {
  getAppDetails,
  getWishlistView,
  upsertCatalogEntry,
  type AppPrice,
  type EndpointContext,
  type WishlistLows,
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
  /** On the user's Steam wishlist. */
  readonly onSteamWishlist: boolean;
  /** Steam's ranking, 1 = top. Null when unranked or not on the Steam wishlist. */
  readonly steamPriority: number | null;
  /** On the SteamGauge watchlist (removable here, can carry a note). */
  readonly watched: boolean;
  readonly note: string | null;
  /** When it was added: to the Steam wishlist if there, otherwise to the watchlist. */
  readonly addedAt: string | null;
  /**
   * 0-based position in "Steam wishlist order": Steam entries by their Steam
   * rank, then watch-only games, most recently watched first.
   */
  readonly listOrder: number;
  /**
   * "priced"       `price` is set. Check `price.discountPercent` for a sale.
   * "free"         The game is free; there is no price to track.
   * "unavailable"  No price right now (not released, or not sold in the US).
   */
  readonly priceStatus: "priced" | "free" | "unavailable";
  readonly price: AppPrice | null;
  readonly saleEndsAt: string | null;
  readonly comingSoon: boolean;
  readonly releaseDate: string | null;
  readonly reviewPercent: number | null;
  readonly reviewCount: number | null;
  /** Historical lows from IsThereAnyDeal. Null when unknown. */
  readonly lows: WishlistLows | null;
}

export interface WishlistPayload {
  readonly items: readonly WishlistItem[];
  /** The most games the SteamGauge watchlist may hold. */
  readonly limit: number;
  /** How many items are on the SteamGauge watchlist. */
  readonly watchedCount: number;
  /**
   * "ok"                 Steam wishlist read.
   * "empty_or_private"   Steam returned nothing. It cannot say which.
   * "unavailable"        Steam could not be asked right now.
   */
  readonly steamStatus: "ok" | "empty_or_private" | "unavailable";
  /** Items whose Steam review totals are still being looked up. */
  readonly reviewsPending: number;
  readonly lowsAvailable: boolean;
}

export type AddResult =
  | { readonly kind: "added"; readonly appid: number }
  | { readonly kind: "app_not_found" }
  | { readonly kind: "wishlist_full" };

// =============================================================================
// Tunables
// =============================================================================

/** The most games the SteamGauge watchlist may hold. */
export const WISHLIST_LIMIT = 50;

/** New per-app review lookups per wishlist request (the rest come from cache). */
const WISHLIST_REVIEW_LOOKUPS = 20;

type Session = { readonly steamid: string };

// =============================================================================
// Read
// =============================================================================

/**
 * The Steam wishlist and the SteamGauge watchlist, merged, with current prices
 * and historical lows.
 *
 * Order: games on sale first (deepest discount on top), then Steam wishlist
 * order, then watchlist-only games, newest first. The page can re-sort
 * (lib/wishlist-sort.ts); `listOrder` keeps the Steam order available.
 *
 * Review totals missing from Steam's store data are filled in the same way
 * as on Deals (lib/steam/review-backfill.ts), with at most
 * WISHLIST_REVIEW_LOOKUPS new lookups per request.
 *
 * @throws if the watchlist cannot be read from the database. If only Steam is
 *         unavailable, the watchlist is still returned with
 *         steamStatus "unavailable".
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
  const local = asArray(tracked.data).filter(isTrackedRow);
  const localByAppid = new Map(local.map((row) => [row.appid, row]));

  let view: Awaited<ReturnType<typeof getWishlistView>> | null = null;
  try {
    const watchedAppids = new Set(local.map((row) => row.appid));
    view = await getWishlistView(session.steamid, [...watchedAppids], ctx, (fresh) =>
      recordWishlistRefresh(fresh.apps, watchedAppids),
    );
  } catch (err) {
    // Steam or the cache is unavailable. The watchlist alone still renders.
    if (!(err instanceof CachedFetchError)) throw err;
  }
  const data = view?.status === "ok" ? view.data : null;

  // Names for watchlist games Steam did not describe, from our catalog.
  const known = new Map((data?.apps ?? []).map((app) => [app.appid, app]));
  const missing = local.map((row) => row.appid).filter((appid) => !known.get(appid)?.name);
  const catalog = new Map<number, CatalogRow>();
  if (missing.length > 0) {
    const rows = await db.from("steam_apps").select("appid,name,header_image,is_free").in("appid", missing);
    if (!rows.error) for (const row of asArray(rows.data).filter(isCatalogRow)) catalog.set(row.appid, row);
  }

  const steamEntries = data?.steam.items ?? [];
  const steamByAppid = new Map(steamEntries.map((entry) => [entry.appid, entry]));
  const order = [
    ...steamEntries.map((entry) => entry.appid),
    ...local.map((row) => row.appid).filter((appid) => !steamByAppid.has(appid)),
  ];

  const drafts: WishlistItem[] = order.map((appid, listOrder) => {
    const steam = steamByAppid.get(appid);
    const watched = localByAppid.get(appid);
    const app = known.get(appid);
    const fallback = catalog.get(appid);
    const priced = app?.priceFinal != null && !app.isFree;
    return {
      appid,
      name: app?.name ?? fallback?.name ?? `App ${appid}`,
      headerImage: app?.headerImage ?? fallback?.header_image ?? null,
      onSteamWishlist: steam !== undefined,
      steamPriority: steam && steam.priority > 0 ? steam.priority : null,
      watched: watched !== undefined,
      note: watched?.note ?? null,
      addedAt: steam?.addedAt ?? watched?.created_at ?? null,
      listOrder,
      priceStatus: priced ? "priced" : app?.isFree || fallback?.is_free ? "free" : "unavailable",
      price:
        priced && app.priceFinal !== null
          ? {
              currency: "USD",
              initial: app.priceInitial ?? app.priceFinal,
              final: app.priceFinal,
              discountPercent: app.discountPercent,
              finalFormatted: null,
            }
          : null,
      saleEndsAt: app?.saleEndsAt ?? null,
      comingSoon: app?.comingSoon ?? false,
      releaseDate: app?.releaseDate ?? null,
      reviewPercent: app?.reviewPercent ?? null,
      reviewCount: app?.reviewCount ?? null,
      lows: data?.lows[String(appid)] ?? null,
    };
  });

  const reviews = await backfillReviews(drafts, ctx, { liveLookups: WISHLIST_REVIEW_LOOKUPS });
  const items: WishlistItem[] = drafts.map((item) => {
    const summary = reviews.summaries.get(item.appid);
    return summary ? { ...item, reviewCount: summary.count, reviewPercent: summary.percent } : item;
  });

  const discount = (item: WishlistItem) => item.price?.discountPercent ?? 0;
  const position = new Map(order.map((appid, index) => [appid, index]));
  items.sort(
    (a, b) =>
      Number(discount(b) > 0) - Number(discount(a) > 0) ||
      discount(b) - discount(a) ||
      (position.get(a.appid) ?? 0) - (position.get(b.appid) ?? 0),
  );

  return {
    status: "ok",
    data: {
      items,
      limit: WISHLIST_LIMIT,
      watchedCount: local.length,
      steamStatus: data ? data.steam.status : "unavailable",
      lowsAvailable: data?.lowsAvailable ?? false,
      reviewsPending: reviews.pending,
    },
    meta: view?.meta ?? { source: "cache", fetchedAt: new Date().toISOString(), stale: false },
  };
}

/**
 * After the wishlist view is refreshed from Steam: add every named app to the
 * catalog (so it is searchable and can be watched), and record today's price
 * of watched games in our own price history.
 */
export async function recordWishlistRefresh(
  apps: readonly { appid: number; name: string | null; headerImage: string; isFree: boolean;
    priceFinal: number | null; priceInitial: number | null; discountPercent: number }[],
  watchedAppids: ReadonlySet<number>,
): Promise<void> {
  const named = apps.filter((app) => app.name);
  if (named.length > 0) {
    const { error } = await getSupabaseAdmin()
      .from("steam_apps")
      .upsert(
        named.map((app) => ({
          appid: app.appid,
          name: app.name,
          header_image: app.headerImage,
          is_free: app.isFree,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "appid" },
      );
    if (error) throw new Error("catalog upsert failed");
  }
  for (const app of apps) {
    if (!watchedAppids.has(app.appid) || app.priceFinal === null || app.isFree) continue;
    await recordPriceObservation(app.appid, DEFAULT_COUNTRY_CODE, {
      currency: "USD",
      initial: app.priceInitial ?? app.priceFinal,
      final: app.priceFinal,
      discountPercent: app.discountPercent,
      finalFormatted: null,
    });
  }
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
