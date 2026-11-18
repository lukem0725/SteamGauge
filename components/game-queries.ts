/**
 * components/game-queries.ts
 *
 * One definition of the per-game queries (v1.9), shared by everything that
 * reads them, so a prefetch fills exactly the cache entry the drawer reads:
 *
 *   insightsQuery(appid, mode)   GET /api/apps/[appid]/insights?mode=...
 *   historyQuery(appid)          GET /api/wishlist/[appid]/history
 *
 * Users: the expanded Deals row, Wishlist cards, the game page, and the hover
 * prefetch below.
 *
 * Hover prefetch
 * --------------
 * prefetchGame() loads a Deals row's drawer data before the click. The
 * Deals table calls it when the mouse rests on a row for PREFETCH_INTENT_MS,
 * or at once when a row's button gets keyboard focus.
 *
 *   - It is skipped when the data is already cached and fresh, when that
 *     request is already running, when the browser asks to save data, and
 *     when MAX_PREFETCHES_IN_FLIGHT are already running.
 *   - Requests carry the prefetch header. The server answers them from its
 *     lower "prefetch" quota tier and declines (503 prefetch_declined) rather
 *     than send degraded data, so a guess never fills the cache with a
 *     half-empty answer. A declined prefetch leaves nothing behind, and the
 *     drawer loads normally on click.
 *   - If the user opens the row while its prefetch is still running, the
 *     drawer shares that request. Should the server then decline it, the
 *     request is repeated as a normal one, so an opened drawer never shows a
 *     prefetch refusal.
 */
import type { QueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, type FocusEvent, type PointerEvent } from "react";

import { apiGet } from "@/lib/api/client";
import type { GameInsights, InsightsMode } from "@/lib/game-insights";
import type { PriceHistory } from "@/lib/price-history";
import { PREFETCH_HEADER } from "@/lib/prefetch-header";

// =============================================================================
// Query definitions
// =============================================================================

/** Player counts refresh on the server every 10 minutes; nothing else is faster. */
export const INSIGHTS_STALE_MS = 5 * 60_000;
export const HISTORY_STALE_MS = 10 * 60_000;

export const insightsQueryKey = (appid: number, mode: InsightsMode) =>
  ["app", "insights", appid, mode] as const;
export const historyQueryKey = (appid: number) => ["wishlist", "history", appid] as const;

const insightsPath = (appid: number, mode: InsightsMode) => `/api/apps/${appid}/insights?mode=${mode}`;
const historyPath = (appid: number) => `/api/wishlist/${appid}/history`;

export function insightsQuery(appid: number, mode: InsightsMode) {
  return {
    queryKey: insightsQueryKey(appid, mode),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      apiGet<GameInsights>(insightsPath(appid, mode), signal),
    staleTime: INSIGHTS_STALE_MS,
    retry: false,
  } as const;
}

export function historyQuery(appid: number) {
  return {
    queryKey: historyQueryKey(appid),
    queryFn: ({ signal }: { signal: AbortSignal }) => apiGet<PriceHistory>(historyPath(appid), signal),
    staleTime: HISTORY_STALE_MS,
    retry: false,
  } as const;
}

// =============================================================================
// Prefetch
// =============================================================================

/** How long the mouse must rest on a row before its data is fetched. */
export const PREFETCH_INTENT_MS = 120;
/** Rows whose prefetch may run at once; more hovers in the meantime are ignored. */
export const MAX_PREFETCHES_IN_FLIGHT = 3;

const inFlight = new Set<number>();

/** For tests. */
export function resetPrefetchState(): void {
  inFlight.clear();
}

function saveDataRequested(): boolean {
  const connection = (globalThis.navigator as { connection?: { saveData?: boolean } } | undefined)
    ?.connection;
  return connection?.saveData === true;
}

/**
 * A queryFn that sends the prefetch header and, if the server declines while
 * someone is now waiting for this query (the drawer opened), asks again as a
 * normal request.
 */
function prefetchFn<T>(queryClient: QueryClient, queryKey: readonly unknown[], path: string) {
  return async ({ signal }: { signal: AbortSignal }) => {
    try {
      return await apiGet<T>(path, signal, { [PREFETCH_HEADER]: "1" });
    } catch (err) {
      const waiting =
        queryClient.getQueryCache().find({ queryKey, exact: true })?.getObserversCount() ?? 0;
      if (!signal.aborted && waiting > 0) return apiGet<T>(path, signal);
      throw err;
    }
  };
}

/** True when the query has fresh data or is already loading. */
function isCoveredFor(queryClient: QueryClient, queryKey: readonly unknown[], staleMs: number): boolean {
  const state = queryClient.getQueryState(queryKey);
  if (!state) return false;
  if (state.fetchStatus === "fetching") return true;
  return state.status === "success" && Date.now() - state.dataUpdatedAt < staleMs;
}

export interface PrefetchOptions {
  /** Warmed in the browser's image cache so the drawer shows it at once. */
  readonly headerImage?: string | null;
}

/**
 * Loads what a Deals drawer shows (full-mode facts and price history) for one
 * game, unless it is already cached or loading. Never throws.
 *
 * @returns true if any request was started.
 */
export function prefetchGame(queryClient: QueryClient, appid: number, options: PrefetchOptions = {}): boolean {
  if (inFlight.has(appid) || inFlight.size >= MAX_PREFETCHES_IN_FLIGHT || saveDataRequested()) {
    return false;
  }

  const jobs: Promise<unknown>[] = [];
  const insightsKey = insightsQueryKey(appid, "full");
  if (!isCoveredFor(queryClient, insightsKey, INSIGHTS_STALE_MS)) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: insightsKey,
        queryFn: prefetchFn<GameInsights>(queryClient, insightsKey, insightsPath(appid, "full")),
        staleTime: INSIGHTS_STALE_MS,
        retry: false,
      }),
    );
  }
  const historyKey = historyQueryKey(appid);
  if (!isCoveredFor(queryClient, historyKey, HISTORY_STALE_MS)) {
    jobs.push(
      queryClient.prefetchQuery({
        queryKey: historyKey,
        queryFn: prefetchFn<PriceHistory>(queryClient, historyKey, historyPath(appid)),
        staleTime: HISTORY_STALE_MS,
        retry: false,
      }),
    );
  }

  if (options.headerImage && typeof Image !== "undefined") {
    const image = new Image();
    image.decoding = "async";
    image.src = options.headerImage;
  }

  if (jobs.length === 0) return false;
  inFlight.add(appid);
  // prefetchQuery never rejects; this only clears the in-flight mark.
  void Promise.allSettled(jobs).then(() => inFlight.delete(appid));
  return true;
}

// =============================================================================
// Intent detection for a list of rows
// =============================================================================

/**
 * Event handlers for the element that CONTAINS the rows (a <tbody>), so rows
 * need no handlers of their own and can be memoised. A row is any descendant
 * with `data-prefetch-appid`.
 *
 *   Mouse rests on a row for PREFETCH_INTENT_MS   -> onIntent(appid)
 *   Keyboard focus moves into a row               -> onIntent(appid), at once
 *   Touch and pen                                 -> nothing (a tap is a click)
 */
export function useRowPrefetchIntent(onIntent: (appid: number) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef<number | null>(null);
  const latest = useRef(onIntent);
  latest.current = onIntent;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    hovered.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const onPointerOver = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType !== "mouse") return;
      const appid = rowAppid(event.target);
      if (appid === hovered.current) return;
      cancel();
      if (appid === null) return;
      hovered.current = appid;
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current(appid);
      }, PREFETCH_INTENT_MS);
    },
    [cancel],
  );

  const onFocus = useCallback((event: FocusEvent<HTMLElement>) => {
    const appid = rowAppid(event.target);
    if (appid !== null) latest.current(appid);
  }, []);

  return { onPointerOver, onPointerLeave: cancel, onFocus };
}

function rowAppid(target: EventTarget | null): number | null {
  const element = target as { closest?: (selector: string) => Element | null } | null;
  const row = element?.closest?.("[data-prefetch-appid]");
  const appid = Number(row?.getAttribute("data-prefetch-appid"));
  return Number.isInteger(appid) && appid > 0 ? appid : null;
}
