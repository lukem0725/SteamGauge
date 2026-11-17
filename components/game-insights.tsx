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
import { formatMoney, useInViewOnce } from "@/components/ui-kit";
import { apiGet } from "@/lib/api/client";
import type { GameInsights, InsightsMode } from "@/lib/game-insights";
import type { PriceHistory } from "@/lib/price-history";

/** Must match MIN_DAYS_FOR_LOW_CLAIM in lib/price-history.ts. */
const DAYS_NEEDED_FOR_LOW = 7;

// =============================================================================
// Data
// =============================================================================

export function useGameInsights(appid: number, mode: InsightsMode, enabled: boolean) {
  return useQuery({
    queryKey: ["app", "insights", appid, mode],
    queryFn: ({ signal }) =>
      apiGet<GameInsights>(`/api/apps/${appid}/insights?mode=${mode}`, signal),
    enabled,
    // Player counts refresh on the server every 10 minutes; nothing else is faster.
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// =============================================================================
// Price history
// =============================================================================

/**
 * @param eager  Load at once (an expanded row the user just opened). Otherwise
 *               it loads when it scrolls into view.
 */
export function PriceHistoryPanel({ appid, eager = false }: { appid: number; eager?: boolean }) {
  const [ref, inView] = useInViewOnce<HTMLDivElement>();
  const enabled = eager || inView;

  const history = useQuery({
    queryKey: ["wishlist", "history", appid],
    queryFn: ({ signal }) => apiGet<PriceHistory>(`/api/wishlist/${appid}/history`, signal),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const data = history.data?.status === "ok" ? history.data.data : null;

  return (
    <div ref={ref}>
      <SectionHeading>Price history</SectionHeading>
      {!enabled || history.isPending ? (
        <div aria-busy="true" aria-label="Loading price history" className="mt-2">
          <div className="h-4 w-48 animate-pulse rounded bg-zinc-800" />
          <div className="mt-3 h-28 animate-pulse rounded-md bg-zinc-800/60" />
        </div>
      ) : !data ? (
        <p className="mt-2 text-sm text-zinc-500">Price history could not be loaded.</p>
      ) : (
        <>
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
      <p className="mt-2 flex items-start gap-2 text-sm text-zinc-200">
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="#0ca30c" className="mt-0.5 h-4 w-4 shrink-0">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-zinc-50">
            {itad ? "Lowest Steam price on record." : "Lowest price we have recorded."}
          </strong>{" "}
          <span className="text-zinc-400">
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
      <p className="mt-2 text-sm text-zinc-300">
        <strong className="font-semibold text-zinc-100">
          {itad ? "Not the lowest on record." : "Not the lowest we have recorded."}
        </strong>{" "}
        <span className="text-zinc-400">
          It was {formatMoney(history.lowest.final, currency)} on {formatDay(history.lowest.date)},{" "}
          {formatMoney(above, currency)} less than now.
        </span>
      </p>
    );
  }

  if (history.lowStatus === "insufficient_history") {
    return itad ? (
      <p className="mt-2 text-sm text-zinc-400">No price history found for this game yet.</p>
    ) : (
      <p className="mt-2 text-sm text-zinc-400">
        {since ? `Tracking since ${since}. ` : "Tracking has just started. "}
        {history.observedDays} of {DAYS_NEEDED_FOR_LOW} days recorded before we can call a low.
      </p>
    );
  }

  return <p className="mt-2 text-sm text-zinc-400">This game has no price to compare right now.</p>;
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
  showFeatures = true,
}: {
  appid: number;
  mode: InsightsMode;
  eager?: boolean;
  /** Already loaded by a parent (the Deals row also needs its prices). */
  insights?: ReturnType<typeof useGameInsights>;
  /** Show at most this many tags (most voted first). Default: all. */
  maxTags?: number;
  /** Show Steam's descriptors ("Single-player", ...). Default true. */
  showFeatures?: boolean;
}) {
  const [ref, inView] = useInViewOnce<HTMLDivElement>();
  const own = useGameInsights(appid, mode, !insights && (eager || inView));
  const query = insights ?? own;
  const data = query.data?.status === "ok" ? query.data.data : null;

  return (
    <div ref={ref}>
      <SectionHeading>About this game</SectionHeading>
      {query.isPending ? (
        <div aria-busy="true" aria-label="Loading game details" className="mt-2 space-y-2">
          <div className="h-4 w-40 animate-pulse rounded bg-zinc-800" />
          <div className="h-4 w-64 animate-pulse rounded bg-zinc-800" />
          <div className="h-6 w-full animate-pulse rounded bg-zinc-800/60" />
        </div>
      ) : !data ? (
        <p className="mt-2 text-sm text-zinc-500">Game details could not be loaded.</p>
      ) : (
        <GameFacts data={data} maxTags={maxTags} showFeatures={showFeatures} />
      )}
    </div>
  );
}

export function GameFacts({
  data,
  maxTags,
  showFeatures = true,
}: {
  data: GameInsights;
  maxTags?: number;
  showFeatures?: boolean;
}) {
  const tags = maxTags === undefined ? data.tags : data.tags.slice(0, Math.max(0, maxTags));
  const rows: { label: string; value: string }[] = [
    { label: data.developers.length > 1 ? "Developers" : "Developer", value: data.developers.join(", ") },
    { label: data.publishers.length > 1 ? "Publishers" : "Publisher", value: data.publishers.join(", ") },
    { label: "Franchise", value: data.franchises.join(", ") },
  ].filter((row) => row.value);

  return (
    <div className="mt-2 space-y-3 text-sm">
      <PlayersNow players={data.players} unavailable={data.unavailable.includes("players")} />

      {rows.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-zinc-500">{row.label}</dt>
              <dd className="min-w-0 break-words text-zinc-200">{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <TagRow label="Genres" items={data.genres} tone="sky" />
      <TagRow label="Tags" items={tags} tone="zinc" />
      {showFeatures ? <TagRow label="Features" items={data.descriptors} tone="outline" /> : null}

      {rows.length === 0 && data.genres.length === 0 && tags.length === 0 ? (
        <p className="text-zinc-500">Steam lists no developer, publisher or tags for this game.</p>
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
      <p className="text-zinc-500">
        {unavailable ? "Live player count unavailable right now." : "Steam reports no live player count for this game."}
      </p>
    );
  }
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(players.asOf)) / 60_000));
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-lg font-semibold tabular-nums text-zinc-50">
          {players.count.toLocaleString("en-US")}
        </span>
        <span className="text-zinc-300">playing now</span>
      </span>
      <span className="text-xs text-zinc-500">
        Steam count, {Number.isFinite(minutes) && minutes > 0 ? `${minutes} min ago` : "just now"}
      </span>
    </p>
  );
}

function TagRow({
  label,
  items,
  tone,
}: {
  label: string;
  items: readonly string[];
  tone: "sky" | "zinc" | "outline";
}) {
  if (items.length === 0) return null;
  const styles = {
    sky: "bg-sky-400/10 text-sky-200 ring-sky-400/30",
    zinc: "bg-zinc-800/80 text-zinc-300 ring-zinc-700",
    outline: "bg-transparent text-zinc-400 ring-zinc-700",
  }[tone];
  return (
    <div>
      <p className="mb-1 text-xs text-zinc-500">{label}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {items.map((item) => (
          <li key={item} className={`rounded-full px-2 py-0.5 text-xs ring-1 ${styles}`}>
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
        <p className="mt-2 text-sm text-zinc-500">
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
          <div key={low.label} className="rounded-lg border border-zinc-800 px-2.5 py-2">
            <dt className="text-[11px] leading-tight text-zinc-500">{low.label}</dt>
            <dd className="mt-0.5 text-sm font-semibold tabular-nums text-zinc-100">
              {low.value === null ? "—" : formatMoney(low.value, currency)}
            </dd>
          </div>
        ))}
      </dl>
      {data.stores.length > 0 ? (
        <table className="mt-3 w-full border-collapse text-left text-sm">
          <caption className="sr-only">Current price at each store, cheapest first</caption>
          <thead>
            <tr className="border-b border-zinc-800 text-xs text-zinc-500">
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
                <tr key={store.shop} className="border-b border-zinc-800/60 last:border-0">
                  <td className="py-1.5 pr-2 text-zinc-200">
                    {store.shop}
                    {store.isSteam ? <span className="ml-1.5 text-xs text-zinc-500">(this deal)</span> : null}
                    {cheaper ? <span className="ml-1.5 text-xs text-emerald-300">cheaper than Steam</span> : null}
                  </td>
                  <td className="py-1.5 pr-2 text-right font-medium tabular-nums text-zinc-100">
                    {formatMoney(store.price, currency)}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums text-zinc-400">
                    {store.cut > 0 ? `-${store.cut}%` : "—"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-zinc-400">
                    {store.storeLow === null ? "—" : formatMoney(store.storeLow, currency)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">No current prices at other stores.</p>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">{children}</h3>;
}
