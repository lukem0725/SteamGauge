import "server-only";

/**
 * lib/api/game-cache.ts
 *
 * Response rules shared by the per-game routes that the Deals drawer, the
 * Wishlist cards and the game page read (v1.9):
 *
 *   GET /api/apps/[appid]/insights
 *   GET /api/wishlist/[appid]/history
 *
 * 1. Shared caching. Their answers are the same for every user (public Steam
 *    and IsThereAnyDeal data, nothing personal), so a complete answer may be
 *    kept by the CDN and served to everyone. A degraded answer (a section
 *    could not be loaded) is never shared, and an answer that our own cache
 *    marked stale is shared only briefly while it refreshes.
 *    The Deals and Wishlist lists are personal (owned, wished and watched
 *    flags) and stay `private, no-store`.
 *
 * 2. Prefetch. The browser sends PREFETCH_HEADER when it loads a row the user
 *    is only hovering. Such a request uses the lower "prefetch" quota tier, is
 *    limited per user, and is refused (503 prefetch_declined) rather than
 *    answered with degraded data, so a guess never leaves a half-empty result
 *    in the browser's cache. The browser then simply loads normally on click.
 */
import type { NextRequest } from "next/server";

import { PREFETCH_HEADER } from "@/lib/prefetch-header";
import type { CacheMeta } from "@/lib/steam/cached-fetch";

export { PREFETCH_HEADER };

/** Hover prefetches per user per minute. A slow sweep down a 50-row page fits. */
export const PREFETCH_PER_MINUTE = 120;

export function isPrefetch(request: NextRequest): boolean {
  return request.headers.get(PREFETCH_HEADER) === "1";
}

export interface SharedCachePolicy {
  /** How long the CDN may serve the answer without asking us. */
  readonly sMaxAge: number;
  /** How much longer it may serve it while it fetches a new one in the background. */
  readonly staleWhileRevalidate: number;
}

/** Price history: the requested 1 h / 24 h. History only grows, and slowly. */
export const HISTORY_CDN: SharedCachePolicy = { sMaxAge: 3600, staleWhileRevalidate: 86_400 };

/**
 * Game facts: shorter, because they include the live player count (fresh for
 * 10 minutes on the server) and every store's current price (1 hour).
 */
export const INSIGHTS_CDN: SharedCachePolicy = { sMaxAge: 600, staleWhileRevalidate: 3600 };

/** While our own cache is refreshing an entry, the CDN keeps it only this long. */
const STALE_CDN: SharedCachePolicy = { sMaxAge: 60, staleWhileRevalidate: 600 };

/** Cache-Control for a complete answer that is the same for every user. */
export function sharedCacheControl(meta: CacheMeta, policy: SharedCachePolicy): string {
  const p = meta.stale ? STALE_CDN : policy;
  return `public, s-maxage=${p.sMaxAge}, stale-while-revalidate=${p.staleWhileRevalidate}`;
}

/** For answers that must not be shared or kept (degraded data). */
export const NO_SHARED_CACHE = "private, no-store";
