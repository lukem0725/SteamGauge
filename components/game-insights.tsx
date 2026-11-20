"use client";

/**
 * components/game-insights.tsx
 *
 * Shared pieces for "more about this game", used by expanded Deals rows and
 * Wishlist cards:
 *
 *   PriceHistoryPanel   multi-year price chart with a plain "lowest on
 *                       record?" statement (GET /api/wishlist/[appid]/history)
 *   GameFactsPanel      live players, developer, publisher, franchise,
 *                       genres, tags and descriptors
 *                       (GET /api/apps/[appid]/insights)
 *   StorePriceList      the game's current price at every store ITAD tracks,
 *                       with historical lows (same request, mode=full)
 *
 * Every request is cached on the server for all users and in TanStack Query
 * here, so re-opening a row or scrolling back to a card costs nothing.
 * Only types are imported from server-only modules.
 */
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { PriceHistoryChart, formatDay } from "@/components/price-history-chart";
import { HISTORY_RECHECK_LIMIT, historyQuery, insightsQuery } from "@/components/game-queries";
import { formatMoney, useInViewOnce } from "@/components/ui-kit";
import type { GameInsights, InsightsMode } from "@/lib/game-insights";
import type { PriceHistory } from "@/lib/price-history";

/** Must match MIN_DAYS_FOR_LOW_CLAIM in lib/price-history.ts. */
const DAYS_NEEDED_FOR_LOW = 7;

// =============================================================================
// Data
// =============================================================================

/** The query is defined once in components/game-queries.ts, shared with prefetch. */
export function useGameInsights(appid: number, mode: InsightsMode, enabled: boolean) {
  return useQuery({ ...insightsQuery(appid, mode), enabled });
}

/**
 * How far ahead of the screen a panel starts loading. Wishlist cards pass a
 * larger margin so the next cards are ready before they scroll into view.
 */
export const DEFAULT_PRELOAD_MARGIN = "120px";
export const WISHLIST_PRELOAD_MARGIN = "800px 0px";

// =============================================================================
// Price history
// =============================================================================

/**
 * @param eager  Load at once (an expanded row the user just opened). Otherwise
 *               it loads when it scrolls into view.
 */
export function PriceHistoryPanel({
  appid,
  eager = false,
  preloadMargin = DEFAULT_PRELOAD_MARGIN,
}: {
  appid: number;
  eager?: boolean;
  /** IntersectionObserver rootMargin for lazy loading. */
  preloadMargin?: string;
}) {
  const [ref, inView] = useInViewOnce<HTMLDivElement>(preloadMargin);
  const enabled = eager || inView;

  const history = useQuery({ ...historyQuery(appid), enabled });

  const data = history.data?.status === "ok" ? history.data.data : null;

  return (
    <div ref={ref}>
      <SectionHeading>Price history</SectionHeading>
      {!enabled || history.isPending ? (
        <div aria-busy="true" aria-label="Loading price history" className="mt-2">
          <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
          <div className="mt-3 h-28 animate-pulse rounded-md bg-slate-800/60" />
        </div>
      ) : !data ? (
        <p className="mt-2 text-sm text-slate-500">Price history could not be loaded.</p>
      ) : (
        <>
          {data.pendingFullHistory ? (
            <PendingHistoryNote
              givenUp={history.dataUpdateCount > HISTORY_RECHECK_LIMIT && !history.isFetching}
              onRetry={() => void history.refetch()}
            />
          ) : null}
          <LowStatusLine history={data} />
          <div className="mt-3">
            <PriceHistoryChart history={data} />
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Shown while the chart holds SteamGauge's own short record in place of
 * IsThereAnyDeal's full history (v1.14.1), so a few days of data is never
 * mistaken for the whole history. The query asks again by itself
 * (components/game-queries.ts); once it stops, the visitor can retry.
 */
function PendingHistoryNote({ givenUp, onRetry }: { givenUp: boolean; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-slate-700/80 bg-slate-900/60 px-3 py-2 text-sm text-slate-300"
    >
      {givenUp ? (
        <>
          <span>
            Full price history couldn&rsquo;t be loaded from IsThereAnyDeal just now. Showing
            SteamGauge&rsquo;s own record.
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="min-h-8 rounded-md px-2 font-medium text-steam-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            Try again
          </button>
        </>
      ) : (
        <span className="flex items-center gap-2">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-steam-400" />
          Loading full price history from IsThereAnyDeal. Showing SteamGauge&rsquo;s own record for now.
        </span>
      )}
    </div>
  );
}

/**
 * States plainly whether the current price is the lowest on record.
 *
 *   ITAD history   Years of Steam price changes: the claim is "lowest Steam
 *                  price on record" since ITAD's first entry.
 *   Local history  SteamGauge's own record: the claim waits for a week of
 *                  history, since before that any price is trivially lowest.
 */
export function LowStatusLine({ history }: { history: PriceHistory }) {
  const currency = history.currency ?? "USD";
  const since = history.firstObservedOn ? formatDay(history.firstObservedOn) : null;
  const itad = history.source === "itad";

  if (history.lowStatus === "at_low" && history.lowest) {
    return (
      <p className="mt-2 flex items-start gap-2 text-sm text-slate-200">
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="#0ca30c" className="mt-0.5 h-4 w-4 shrink-0">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-slate-50">
            {itad ? "Lowest Steam price on record." : "Lowest price we have recorded."}
          </strong>{" "}
          <span className="text-slate-400">
            {itad
              ? `History since ${since ?? "the first record"}.`
              : `${history.observedDays} days tracked${since ? `, since ${since}` : ""}.`}
          </span>
        </span>
      </p>
    );
  }

  if (history.lowStatus === "above_low" && history.lowest && history.currentFinal !== null) {
    const above = history.currentFinal - history.lowest.final;
    return (
      <p className="mt-2 text-sm text-slate-300">
        <strong className="font-semibold text-slate-100">
          {itad ? "Not the lowest on record." : "Not the lowest we have recorded."}
        </strong>{" "}
        <span className="text-slate-400">
          It was {formatMoney(history.lowest.final, currency)} on {formatDay(history.lowest.date)},{" "}
          {formatMoney(above, currency)} less than now.
        </span>
      </p>
    );
  }

  if (history.lowStatus === "insufficient_history") {
    return itad ? (
      <p className="mt-2 text-sm text-slate-400">No price history found for this game yet.</p>
    ) : (
      <p className="mt-2 text-sm text-slate-400">
        {since ? `Tracking since ${since}. ` : "Tracking has just started. "}
        {history.observedDays} of {DAYS_NEEDED_FOR_LOW} days recorded before we can call a low.
      </p>
    );
  }

  return <p className="mt-2 text-sm text-slate-400">This game has no price to compare right now.</p>;
}

// =============================================================================
// Game facts
// =============================================================================

/**
 * Live players and store metadata for one game.
 *
 * @param eager  Load at once; otherwise when scrolled into view.
 * @param mode   "full" for an expanded Deals row, "card" for a Wishlist card.
 */
export function GameFactsPanel({
  appid,
  mode,
  eager = false,
  insights,
  maxTags,
  maxFeatures,
  showFeatures = true,
  showPlayers = true,
  preloadMargin = DEFAULT_PRELOAD_MARGIN,
}: {
  appid: number;
  mode: InsightsMode;
  eager?: boolean;
  /** Already loaded by a parent (the Deals row also needs its prices). */
  insights?: ReturnType<typeof useGameInsights>;
  /** Show at most this many tags (most voted first). Default: all. */
  maxTags?: number;
  /** Show at most this many features. Default: all. */
  maxFeatures?: number;
  /** Show Steam's descriptors ("Single-player", ...). Default true. */
  showFeatures?: boolean;
  /** Show the live player count. Default true; the game page shows it in its header instead. */
  showPlayers?: boolean;
  /** IntersectionObserver rootMargin for lazy loading. */
  preloadMargin?: string;
}) {
  const [ref, inView] = useInViewOnce<HTMLDivElement>(preloadMargin);
  const own = useGameInsights(appid, mode, !insights && (eager || inView));
  const query = insights ?? own;
  const data = query.data?.status === "ok" ? query.data.data : null;

  return (
    <div ref={ref}>
      <SectionHeading>About this game</SectionHeading>
      {query.isPending ? (
        <div aria-busy="true" aria-label="Loading game details" className="mt-2 space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-64 animate-pulse rounded bg-slate-800" />
          <div className="h-6 w-full animate-pulse rounded bg-slate-800/60" />
        </div>
      ) : !data ? (
        <p className="mt-2 text-sm text-slate-500">Game details could not be loaded.</p>
      ) : (
        <GameFacts data={data} maxTags={maxTags} maxFeatures={maxFeatures} showFeatures={showFeatures} showPlayers={showPlayers} />
      )}
    </div>
  );
}

export function GameFacts({
  data,
  maxTags,
  maxFeatures,
  showFeatures = true,
  showPlayers = true,
}: {
  data: GameInsights;
  maxTags?: number;
  maxFeatures?: number;
  showFeatures?: boolean;
  showPlayers?: boolean;
}) {
  // Deduplicate before limiting, so a repeated name never uses up a slot.
  const tags = limit(uniqueItems(data.tags), maxTags);
  const features = limit(uniqueItems(data.descriptors), maxFeatures);
  const rows: { label: string; value: string }[] = [
    { label: data.developers.length > 1 ? "Developers" : "Developer", value: data.developers.join(", ") },
    { label: data.publishers.length > 1 ? "Publishers" : "Publisher", value: data.publishers.join(", ") },
    { label: "Franchise", value: data.franchises.join(", ") },
  ].filter((row) => row.value);

  return (
    <div className="mt-2 space-y-3 text-sm">
      {showPlayers ? <PlayersNow players={data.players} unavailable={data.unavailable.includes("players")} /> : null}

      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-slate-500">{row.label}</dt>
              <dd className="min-w-0 break-words text-slate-200">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <TagRow label="Genres" items={data.genres} tone="sky" />
      <TagRow label="Tags" items={tags} tone="slate" />
      {showFeatures ? <TagRow label="Features" items={features} tone="outline" /> : null}

      {rows.length === 0 && data.genres.length === 0 && tags.length === 0 ? (
        <p className="text-slate-500">Steam lists no developer, publisher or tags for this game.</p>
      ) : null}
    </div>
  );
}

function PlayersNow({
  players,
  unavailable,
}: {
  players: GameInsights["players"];
  unavailable: boolean;
}) {
  if (!players) {
    return (
      <p className="text-slate-500">
        {unavailable ? "Live player count unavailable right now." : "Steam reports no live player count for this game."}
      </p>
    );
  }
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(players.asOf)) / 60_000));
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-steam-400" />
        <span className="text-lg font-semibold tabular-nums text-slate-50">
          {players.count.toLocaleString("en-US")}
        </span>
        <span className="text-slate-300">playing now</span>
      </span>
      <span className="text-xs text-slate-500">
        Steam count, {Number.isFinite(minutes) && minutes > 0 ? `${minutes} min ago` : "just now"}
      </span>
    </p>
  );
}

/** First occurrence of each non-empty name. Steam can repeat a descriptor. */
function uniqueItems(items: readonly string[]): string[] {
  return Array.from(new Set(items.map((item) => item.trim()).filter(Boolean)));
}

function limit<T>(items: readonly T[], max: number | undefined): T[] {
  return max === undefined ? [...items] : items.slice(0, Math.max(0, max));
}

function TagRow({
  label,
  items,
  tone,
}: {
  label: string;
  items: readonly string[];
  tone: "sky" | "slate" | "outline";
}) {
  const list = uniqueItems(items);
  if (list.length === 0) return null;
  const styles = {
    sky: "bg-sky-400/10 text-sky-200 ring-sky-400/30",
    slate: "bg-slate-800/80 text-slate-300 ring-slate-700",
    outline: "bg-transparent text-slate-400 ring-slate-700",
  }[tone];
  return (
    <div>
      <p className="mb-1 text-xs text-slate-500">{label}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {list.map((item, index) => (
          <li key={`${item}-${index}`} className={`rounded-full px-2 py-0.5 text-xs ring-1 ${styles}`}>
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

// =============================================================================
// Prices at every store
// =============================================================================

export function StorePriceList({
  data,
  steamPrice,
  unavailable,
}: {
  data: GameInsights["prices"];
  /** Steam's current price, in cents, to mark cheaper stores. */
  steamPrice: number;
  unavailable: boolean;
}) {
  if (!data) {
    return (
      <div>
        <SectionHeading>Price breakdown</SectionHeading>
        <p className="mt-2 text-sm text-slate-500">
          {unavailable ? "Store prices could not be loaded right now." : "Store prices are not connected."}
        </p>
      </div>
    );
  }
  const currency = data.currency ?? "USD";
  const lows: { label: string; value: number | null }[] = [
    { label: "Steam all-time low", value: data.steamLow },
    { label: "All-time low, any store", value: data.allTimeLow },
    { label: "1-year low, any store", value: data.yearLow },
    { label: "3-month low, any store", value: data.threeMonthLow },
  ];
  return (
    <div>
      <SectionHeading>Price breakdown</SectionHeading>
      <dl className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {lows.map((low) => (
          <div key={low.label} className="rounded-lg border border-slate-800 px-2.5 py-2">
            <dt className="text-[11px] leading-tight text-slate-500">{low.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-slate-100">
              {low.value === null ? "—" : formatMoney(low.value, currency)}
            </dd>
          </div>
        ))}
      </dl>
      {data.stores.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Current price at each store, cheapest first. Store names link to the game at that store.</caption>
          <thead>
            <tr className="border-b border-slate-800 text-xs text-slate-500">
              <th scope="col" className="py-1.5 pr-2 font-medium">Store</th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">Price</th>
              <th scope="col" className="py-1.5 pr-2 text-right font-medium">Cut</th>
              <th scope="col" className="py-1.5 text-right font-medium">Lowest there</th>
            </tr>
          </thead>
          <tbody>
            {data.stores.map((store) => {
              const cheaper = !store.isSteam && store.price < steamPrice;
              return (
                <tr key={store.shop} className="border-b border-slate-800/60 last:border-0">
                  <td className="py-1.5 pr-2 text-slate-200">
                    {store.url ? (
                      <a
                        href={store.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 rounded font-medium text-slate-100 underline decoration-slate-600 underline-offset-2 hover:text-white hover:decoration-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
                      >
                        {store.shop}
                        <ExternalIcon />
                        <span className="sr-only"> (opens {store.shop} in a new tab)</span>
                      </a>
                    ) : (
                      store.shop
                    )}
                    {store.isSteam ? <span className="ml-1.5 text-xs text-slate-500">(this deal)</span> : null}
                    {cheaper ? <span className="ml-1.5 text-xs text-steam-300">cheaper than Steam</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-medium tabular-nums text-slate-100">
                    {store.url ? (
                      // Same destination as the store name; out of the tab order
                      // and hidden from screen readers so it is not announced twice.
                      <a
                        href={store.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        tabIndex={-1}
                        aria-hidden="true"
                        className="hover:text-white hover:underline"
                      >
                        {formatMoney(store.price, currency)}
                      </a>
                    ) : (
                      formatMoney(store.price, currency)
                    )}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-slate-400">
                    {store.cut > 0 ? `-${store.cut}%` : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-slate-400">
                    {store.storeLow === null ? "—" : formatMoney(store.storeLow, currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-sm text-slate-500">No current prices at other stores.</p>
      )}
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="h-3 w-3 shrink-0 text-slate-500">
      <path d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9 2h5v5M14 2 7 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium uppercase tracking-wider text-slate-500">{children}</h3>;
}
