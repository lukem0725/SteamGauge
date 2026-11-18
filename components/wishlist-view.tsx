"use client";

/**
 * components/wishlist-view.tsx
 *
 * The wishlist: the user's live Steam wishlist merged with their SteamGauge
 * watchlist, with current prices, historical lows and price history.
 *
 * Steam wishlist entries are read-only here; changes are never sent to Steam.
 * "Watch" adds a game to the SteamGauge watchlist (stored in Supabase), which
 * also lets you keep a note on it and tracks its price daily.
 *
 *   GET    /api/wishlist                   tracked games with current prices
 *   POST   /api/wishlist                   track a game
 *   DELETE /api/wishlist/[appid]           stop tracking
 *   GET    /api/wishlist/[appid]/history   price history, loaded per card
 *                                          once that card scrolls into view
 *   GET    /api/apps/[appid]/insights?mode=card
 *                                          live players, developer, publisher,
 *                                          franchise, tags; also per card, in view
 *
 * Mobile-first: laid out for a 360px portrait screen, widening at sm/lg.
 * Only types are imported from server-only modules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";

import {
  GameFactsPanel,
  PriceHistoryPanel,
  WISHLIST_PRELOAD_MARGIN,
} from "@/components/game-insights";
import {
  DataAgeTicker,
  ErrorState,
  StatePanel,
  describeWishlistAddError,
  formatMoney,
  primaryButton,
  secondaryButton,
} from "@/components/ui-kit";
import { pageContainer } from "@/components/layout-width";
import { TitleFilter } from "@/components/title-filter";
import { apiGet, apiSend } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import { matchesTitle } from "@/lib/title-search";
import type { WishlistItem, WishlistPayload } from "@/lib/wishlist";
import {
  DEFAULT_WISHLIST_SORT,
  WISHLIST_SORTS,
  isWishlistSort,
  sortWishlist,
  type WishlistSort,
} from "@/lib/wishlist-sort";

/** After a stale answer, re-check this many times for the refreshed data. */
const STALE_RECHECK_LIMIT = 2;
const STALE_RECHECK_MS = 4_000;


/** Cards rendered per "Show more" step. Each loads its chart when visible. */
const PAGE_STEP = 20;

const STEAM_PRIVACY_SETTINGS_URL = "https://steamcommunity.com/my/edit/settings";

/** Remembers the chosen sort in this browser. A convenience only. */
const SORT_STORAGE_KEY = "steamgauge.wishlist.sort";
/** Where the choice was saved before the rename to SteamGauge. Read once, if present. */
const LEGACY_SORT_STORAGE_KEY = "steaml" + "ite.wishlist.sort";

// =============================================================================
// Entry point
// =============================================================================

export interface WishlistViewProps {
  /** The verified session user, from the Server Component. */
  readonly user: SessionUser;
}

/** Moved to components/game-insights.tsx; re-exported for existing imports. */
export { LowStatusLine } from "@/components/game-insights";

export function WishlistView({ user }: WishlistViewProps) {
  return <Wishlist user={user} />;
}

function Wishlist({ user }: WishlistViewProps) {
  const queryKey = ["wishlist", user.steamid] as const;
  const [limit, setLimit] = useState(PAGE_STEP);
  const [sort, setSort] = useState<WishlistSort>(DEFAULT_WISHLIST_SORT);

  // Read the saved choice after mount, so server and first client render match.
  useEffect(() => {
    try {
      const saved =
        window.localStorage.getItem(SORT_STORAGE_KEY) ??
        window.localStorage.getItem(LEGACY_SORT_STORAGE_KEY);
      if (isWishlistSort(saved)) setSort(saved);
    } catch {
      // Storage blocked (private mode, embedded view): keep the default.
    }
  }, []);
  const chooseSort = (next: WishlistSort) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, next);
    } catch {
      // Not saved; the choice still applies for this visit.
    }
  };

  const wishlist = useQuery({
    queryKey,
    queryFn: ({ signal }) => apiGet<WishlistPayload>("/api/wishlist", signal),
    staleTime: 60_000,
    // Bounded follow-up after a stale answer, not polling (doc 4.1).
    refetchInterval: (query) =>
      query.state.data?.meta.stale && query.state.dataUpdateCount <= STALE_RECHECK_LIMIT
        ? STALE_RECHECK_MS
        : false,
  });

  const result = wishlist.data;
  const payload = result?.status === "ok" ? result.data : null;
  const items = useMemo(() => sortWishlist(payload?.items ?? [], sort), [payload?.items, sort]);
  const onSale = items.filter(isOnSale).length;
  const fromSteam = items.filter((item) => item.onSteamWishlist).length;

  // The box above the list filters by title; a pasted Steam link or App ID
  // isolates that game, or offers to watch it if it is not here yet.
  const [query, setQuery] = useState("");
  const trimmed = query.trim();
  const linkedAppid = parseAppReference(trimmed);
  const matching = useMemo(
    () =>
      trimmed
        ? items.filter((item) => item.appid === linkedAppid || matchesTitle(trimmed, item.name))
        : items,
    [items, trimmed, linkedAppid],
  );
  const [shownQuery, setShownQuery] = useState(trimmed);
  if (shownQuery !== trimmed) {
    setShownQuery(trimmed);
    setLimit(PAGE_STEP);
  }
  const shown = matching.slice(0, limit);
  const watchCandidate =
    linkedAppid !== null && !items.some((item) => item.appid === linkedAppid) ? linkedAppid : null;

  return (
    <div className="bg-page text-slate-100 antialiased">
      <div className={pageContainer}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Wishlist</h1>
            <p className="mt-1 text-sm text-slate-400">
              {payload && items.length > 0
                ? `${items.length} ${items.length === 1 ? "game" : "games"} · ${onSale} on sale right now.`
                : "Your Steam wishlist and the games you watch here."}
            </p>
          </div>
          <div className="pt-1">
            <DataAgeTicker meta={result?.meta ?? null} isFetching={wishlist.isFetching} />
          </div>
        </header>

        <main className="mt-6 space-y-4">
          {payload ? <SyncNotice payload={payload} fromSteam={fromSteam} /> : null}

          {payload ? (
            <WishlistToolbar
              query={query}
              onQuery={setQuery}
              sort={sort}
              onSort={chooseSort}
              shown={shown.length}
              matching={matching.length}
              total={items.length}
              reviewsPending={payload.reviewsPending}
              watchCandidate={watchCandidate}
              queryKey={queryKey}
              full={payload.watchedCount >= payload.limit}
              limit={payload.limit}
            />
          ) : null}

          {wishlist.isPending ? (
            <WishlistSkeleton />
          ) : wishlist.isError ? (
            <ErrorState
              error={wishlist.error}
              onRetry={() => void wishlist.refetch()}
              retrying={wishlist.isFetching}
              subject="your wishlist"
            />
          ) : items.length === 0 ? (
            <StatePanel tone="neutral" title="Nothing on your wishlist yet">
              <p>
                Wishlist games on Steam and they appear here within about 30 minutes. To watch a
                game in SteamGauge only, find it with the search at the top, or paste its Steam
                store link in the box above.
              </p>
            </StatePanel>
          ) : matching.length === 0 ? (
            watchCandidate !== null ? null : (
              <div className="rounded-2xl border border-slate-800 bg-surface p-6 text-center">
                <p className="text-base font-medium text-slate-200">
                  No games in your wishlist match &ldquo;{trimmed}&rdquo;
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  This filters only your wishlist. To find any game on Steam, use the search at the
                  top.{" "}
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
                  >
                    Clear the filter
                  </button>
                </p>
              </div>
            )
          ) : (
            <>
              <ul aria-label="Wishlist games" className="space-y-3">
                {shown.map((item) => (
                  <WishlistCard key={item.appid} item={item} queryKey={queryKey} />
                ))}
              </ul>
              {matching.length > shown.length ? (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => setLimit((current) => current + PAGE_STEP)}
                    className={secondaryButton}
                  >
                    Show {Math.min(PAGE_STEP, matching.length - shown.length)} more
                    <span className="sr-only"> wishlist games</span>
                  </button>
                </div>
              ) : null}
              <p className="pt-2 text-xs leading-relaxed text-slate-500">
                Prices are current US Steam prices. Steam wishlist entries are read-only here:
                watching, notes and removals stay in SteamGauge and are never sent to Steam.
                {payload?.lowsAvailable ? (
                  <>
                    {" "}Historical lows and price history from{" "}
                    <a
                      href="https://isthereanydeal.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-slate-700 underline-offset-2 hover:text-slate-300"
                    >
                      IsThereAnyDeal
                    </a>
                    .
                  </>
                ) : null}
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

/**
 * Above the list: the title filter (which also accepts a Steam link or App
 * ID), the sort menu, and how many games are shown.
 */
function WishlistToolbar({
  query,
  onQuery,
  sort,
  onSort,
  shown,
  matching,
  total,
  reviewsPending,
  watchCandidate,
  queryKey,
  full,
  limit,
}: {
  query: string;
  onQuery: (query: string) => void;
  sort: WishlistSort;
  onSort: (sort: WishlistSort) => void;
  shown: number;
  matching: number;
  total: number;
  reviewsPending: number;
  /** An App ID from a pasted link that is not in the list yet. */
  watchCandidate: number | null;
  queryKey: readonly unknown[];
  full: boolean;
  limit: number;
}) {
  const id = useId();
  const filtering = query.trim() !== "";
  return (
    <div className="rounded-2xl border border-slate-800 bg-surface px-4 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <TitleFilter
          value={query}
          onChange={onQuery}
          label="Filter your wishlist by title, or paste a Steam store link or App ID"
          placeholder="Filter your wishlist by title, or paste a Steam link"
          className="w-full sm:flex-1"
        />
        <div className="flex min-w-0 items-center gap-3">
          <label htmlFor={id} className="shrink-0 text-sm font-medium text-slate-300">
            Sort by
          </label>
          <select
            id={id}
            value={sort}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              if (isWishlistSort(event.target.value)) onSort(event.target.value);
            }}
            className="min-h-10 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus-visible:border-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400/40 sm:w-60"
          >
            {WISHLIST_SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p aria-live="polite" className="text-xs text-slate-500">
          {filtering ? (
            <>
              <span className="tabular-nums text-slate-300">{matching}</span> of{" "}
              <span className="tabular-nums text-slate-300">{total}</span> match
              {matching > shown ? ` · showing ${shown}` : ""}
            </>
          ) : (
            <>
              Showing <span className="tabular-nums text-slate-300">{shown}</span> of{" "}
              <span className="tabular-nums text-slate-300">{total}</span>
            </>
          )}
          {sort === "rating-desc" && reviewsPending > 0
            ? ` · ${reviewsPending} ${reviewsPending === 1 ? "rating" : "ratings"} still loading`
            : null}
        </p>
        {full ? (
          <p className="text-xs text-amber-300">
            Your SteamGauge watchlist is full ({limit} games). Stop watching one to add another.
          </p>
        ) : null}
      </div>
      {watchCandidate !== null ? (
        <WatchFromLink
          appid={watchCandidate}
          queryKey={queryKey}
          full={full}
          limit={limit}
          onWatched={() => onQuery("")}
        />
      ) : null}
    </div>
  );
}

/** Shown when the box holds a Steam link or App ID that is not in the list. */
function WatchFromLink({
  appid,
  queryKey,
  full,
  limit,
  onWatched,
}: {
  appid: number;
  queryKey: readonly unknown[];
  full: boolean;
  limit: number;
  onWatched: () => void;
}) {
  const queryClient = useQueryClient();
  const add = useMutation({
    mutationFn: () => apiSend("POST", "/api/wishlist", { appid }),
    onSuccess: () => {
      onWatched();
      // The deals list shows which games are watched, so refresh it too.
      void queryClient.invalidateQueries({ queryKey: ["deals"] });
      return queryClient.invalidateQueries({ queryKey });
    },
  });
  return (
    <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-steam-400/25 bg-steam-400/5 px-3 py-2.5">
      <p className="min-w-0 flex-1 text-sm text-slate-300">
        Steam app <span className="font-semibold tabular-nums text-slate-100">{appid}</span> is not in
        your wishlist.
      </p>
      <button type="button" onClick={() => add.mutate()} disabled={add.isPending || full} className={primaryButton}>
        {add.isPending ? "Adding…" : `Watch app ${appid}`}
      </button>
      {add.isError ? (
        <p role="alert" className="w-full text-sm text-rose-300">
          {describeWishlistAddError(add.error, limit)}
        </p>
      ) : null}
    </div>
  );
}

function isOnSale(item: WishlistItem): boolean {
  return item.priceStatus === "priced" && (item.price?.discountPercent ?? 0) > 0;
}

/** Where the list comes from, and what to do when Steam returned nothing. */
function SyncNotice({ payload, fromSteam }: { payload: WishlistPayload; fromSteam: number }) {
  if (payload.steamStatus === "ok") {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-400">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-steam-400" />
        Synced from your Steam wishlist: {fromSteam} {fromSteam === 1 ? "game" : "games"}.
      </p>
    );
  }
  if (payload.steamStatus === "unavailable") {
    return (
      <p className="rounded-2xl border border-slate-800 bg-surface px-4 py-3 text-sm text-slate-400">
        Steam could not be reached just now, so only games you watch in SteamGauge are shown.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm leading-relaxed text-slate-300">
      <p>
        <strong className="font-medium text-amber-200">Steam returned no wishlist.</strong> It is
        either empty or private. Steam shows your wishlist to apps only when your profile&rsquo;s{" "}
        <strong className="font-medium text-slate-100">Game details</strong> are public.
      </p>
      <a
        href={STEAM_PRIVACY_SETTINGS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-flex min-h-9 items-center font-medium text-amber-200 underline decoration-amber-400/40 underline-offset-2 hover:decoration-amber-300"
      >
        Open Steam privacy settings
      </a>
    </div>
  );
}

// =============================================================================
// Add a game
// =============================================================================

/** Accepts "730" or any Steam store link containing /app/730. */
export function parseAppReference(input: string): number | null {
  const text = input.trim();
  const match = /^(\d{1,7})$/.exec(text) ?? /store\.steampowered\.com\/app\/(\d{1,7})(?:\D|$)/i.exec(text);
  const appid = match?.[1] ? Number(match[1]) : NaN;
  return Number.isInteger(appid) && appid >= 1 ? appid : null;
}

// =============================================================================
// One wishlist game
// =============================================================================

function WishlistCard({ item, queryKey }: { item: WishlistItem; queryKey: readonly unknown[] }) {
  const queryClient = useQueryClient();
  const refresh = () => {
    // The deals table shows which games are watched, so refresh it too.
    void queryClient.invalidateQueries({ queryKey: ["deals"] });
    return queryClient.invalidateQueries({ queryKey });
  };
  const watch = useMutation({
    mutationFn: () => apiSend("POST", "/api/wishlist", { appid: item.appid }),
    onSuccess: refresh,
  });
  const unwatch = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/wishlist/${item.appid}`),
    onSuccess: refresh,
  });

  return (
    <li className="relative overflow-hidden rounded-2xl border border-slate-800 bg-surface-raised">
      <div className="flex flex-col sm:flex-row">
        {/* Left column: header image, and the game's facts directly under it. */}
        <div className="shrink-0 sm:m-4 sm:mr-0 sm:w-64 sm:self-start lg:w-72">
        <div className="relative aspect-[460/215] w-full overflow-hidden bg-slate-900 sm:rounded-xl">
          {item.headerImage ? (
            // Steam CDN image; a plain <img> avoids next/image remote configuration.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={item.headerImage}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#1e2836,#121822)]">
              <span aria-hidden="true" className="text-2xl font-semibold text-slate-600">
                {item.name.slice(0, 1).toUpperCase()}
              </span>
            </div>
          )}
        </div>
        <div className="border-b border-slate-800 px-4 py-4 sm:border-b-0 sm:px-0 sm:pb-0">
          <GameFactsPanel
            appid={item.appid}
            mode="card"
            maxFeatures={5}
            preloadMargin={WISHLIST_PRELOAD_MARGIN}
          />
        </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-base font-semibold text-slate-50" title={item.name}>
              {item.name}
            </h2>
            <DiscountBadge item={item} />
          </div>

          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {item.onSteamWishlist ? (
              <SourceChip tone="violet">
                Steam wishlist{item.steamPriority ? ` #${item.steamPriority}` : ""}
              </SourceChip>
            ) : null}
            {item.watched ? <SourceChip tone="steam">Watching</SourceChip> : null}
            {item.comingSoon ? <SourceChip tone="slate">Coming soon</SourceChip> : null}
            {item.reviewPercent !== null ? (
              <SourceChip tone="slate">
                {item.reviewPercent}% positive
                {item.reviewCount ? ` · ${item.reviewCount.toLocaleString("en-US")} reviews` : ""}
              </SourceChip>
            ) : null}
          </div>

          <CurrentPrice item={item} />
          <LowsLine item={item} />

          {item.note ? (
            <p className="mt-2 break-words text-sm text-slate-400">
              <span className="sr-only">Your note: </span>
              {item.note}
            </p>
          ) : null}

          {item.priceStatus === "free" ? null : (
            <div className="mt-4 border-t border-slate-800 pt-3">
              <PriceHistoryPanel appid={item.appid} preloadMargin={WISHLIST_PRELOAD_MARGIN} />
            </div>
          )}


          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {item.watched ? (
              <button
                type="button"
                onClick={() => unwatch.mutate()}
                disabled={unwatch.isPending}
                className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {unwatch.isPending ? "Removing…" : item.onSteamWishlist ? "Stop watching" : "Remove"}
                <span className="sr-only"> {item.name}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => watch.mutate()}
                disabled={watch.isPending}
                className={primaryButton}
              >
                {watch.isPending ? "Adding…" : "Watch in SteamGauge"}
                <span className="sr-only">: {item.name}</span>
              </button>
            )}
            <a
              href={`https://store.steampowered.com/app/${item.appid}`}
              target="_blank"
              rel="noopener noreferrer"
              className={secondaryButton}
            >
              View on Steam
              <span className="sr-only"> (opens in a new tab): {item.name}</span>
            </a>
          </div>
          {watch.isError ? (
            <p role="alert" className="mt-2 text-sm text-rose-300">
              {describeWishlistAddError(watch.error, null)}
            </p>
          ) : null}
          {unwatch.isError ? (
            <p role="alert" className="mt-2 text-sm text-rose-300">
              Could not stop watching this game. Try again.
            </p>
          ) : null}
          {item.onSteamWishlist && !item.watched ? (
            <p className="mt-2 text-xs text-slate-500">
              To remove it from your Steam wishlist, use Steam. SteamGauge never changes it.
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SourceChip({ tone, children }: { tone: "violet" | "steam" | "slate"; children: ReactNode }) {
  const styles = {
    violet: "bg-violet-400/10 text-violet-300 ring-violet-400/30",
    steam: "bg-steam-400/10 text-steam-300 ring-steam-400/30",
    slate: "bg-slate-800/70 text-slate-400 ring-slate-700",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${styles}`}>
      {children}
    </span>
  );
}

/** Discount status as a labelled badge, never colour alone. */
function DiscountBadge({ item }: { item: WishlistItem }) {
  const base = "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1";
  if (item.priceStatus === "unavailable") {
    return (
      <span className={`${base} bg-slate-800/60 text-slate-400 ring-slate-700`}>
        {item.comingSoon ? "Not released" : "Price unavailable"}
      </span>
    );
  }
  if (item.priceStatus === "free") {
    return <span className={`${base} bg-sky-400/10 text-sky-300 ring-sky-400/30`}>Free to play</span>;
  }
  const percent = item.price?.discountPercent ?? 0;
  return percent > 0 ? (
    <span className={`${base} bg-steam-400/15 tabular-nums text-steam-300 ring-steam-400/40`}>
      On sale -{percent}%
    </span>
  ) : (
    <span className={`${base} bg-slate-800/60 text-slate-300 ring-slate-700`}>Full price</span>
  );
}

function CurrentPrice({ item }: { item: WishlistItem }) {
  if (item.priceStatus !== "priced" || !item.price) return null;
  const { price } = item;
  const ends = item.saleEndsAt ? new Date(item.saleEndsAt) : null;
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-slate-50">
        {formatMoney(price.final, price.currency)}
      </span>
      {price.discountPercent > 0 ? (
        <s className="text-sm tabular-nums text-slate-500">
          <span className="sr-only">was </span>
          {formatMoney(price.initial, price.currency)}
        </s>
      ) : null}
      {price.discountPercent > 0 && ends && !Number.isNaN(ends.getTime()) ? (
        <span className="text-xs text-slate-500">
          Sale ends{" "}
          <time dateTime={item.saleEndsAt ?? undefined}>
            {ends.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </time>
        </span>
      ) : null}
    </p>
  );
}

/** Historical lows from IsThereAnyDeal, beside the current price. */
function LowsLine({ item }: { item: WishlistItem }) {
  const lows = item.lows;
  if (!lows || (lows.steamLow === null && lows.yearLowAnyStore === null)) return null;
  const current = item.price?.final ?? null;
  const atLow = current !== null && lows.steamLow !== null && current <= lows.steamLow;
  return (
    <p className="mt-1 text-xs text-slate-400">
      {lows.steamLow !== null ? (
        <span>
          Steam all-time low{" "}
          <span className={`font-semibold tabular-nums ${atLow ? "text-steam-300" : "text-slate-200"}`}>
            {formatMoney(lows.steamLow, "USD")}
          </span>
          {atLow ? <span className="text-steam-300"> · at its low now</span> : null}
        </span>
      ) : null}
      {lows.steamLow !== null && lows.yearLowAnyStore !== null ? (
        <span aria-hidden="true" className="mx-1.5 text-slate-700">·</span>
      ) : null}
      {lows.yearLowAnyStore !== null ? (
        <span>
          1-year low, any store{" "}
          <span className="font-semibold tabular-nums text-slate-200">
            {formatMoney(lows.yearLowAnyStore, "USD")}
          </span>
        </span>
      ) : null}
    </p>
  );
}

// =============================================================================
// Loading state
// =============================================================================

function WishlistSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your wishlist" className="space-y-3">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-surface-raised sm:flex-row"
        >
          <div className="aspect-[460/215] w-full shrink-0 animate-pulse bg-slate-900 sm:m-4 sm:mr-0 sm:w-64 sm:self-start sm:rounded-xl lg:w-72" />
          <div className="flex-1 space-y-3 p-4">
            <div className="h-5 w-2/3 animate-pulse rounded bg-slate-800" />
            <div className="h-7 w-24 animate-pulse rounded bg-slate-800" />
            <div className="h-28 w-full animate-pulse rounded-md bg-slate-800/60" />
          </div>
        </div>
      ))}
    </div>
  );
}
