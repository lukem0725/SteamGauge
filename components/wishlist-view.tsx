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
  type FormEvent,
  type ReactNode,
} from "react";

import { GameFactsPanel, PriceHistoryPanel } from "@/components/game-insights";
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
import { apiGet, apiSend } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
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
  const shown = items.slice(0, limit);

  return (
    <div className="bg-zinc-950 text-zinc-100 antialiased">
      <div className={pageContainer}>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Wishlist</h1>
            <p className="mt-1 text-sm text-zinc-400">
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

          <AddGameForm
            queryKey={queryKey}
            full={payload !== null && payload.watchedCount >= payload.limit}
            limit={payload?.limit ?? null}
          />

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
                Wishlist games on Steam and they appear here within about 30 minutes, or paste a
                Steam store link above to watch a game in SteamGauge only.
              </p>
            </StatePanel>
          ) : (
            <>
              <SortToolbar
                sort={sort}
                onSort={chooseSort}
                shown={shown.length}
                total={items.length}
                reviewsPending={payload?.reviewsPending ?? 0}
              />
              <ul aria-label="Wishlist games" className="space-y-3">
                {shown.map((item) => (
                  <WishlistCard key={item.appid} item={item} queryKey={queryKey} />
                ))}
              </ul>
              {items.length > shown.length ? (
                <div className="flex justify-center pt-1">
                  <button
                    type="button"
                    onClick={() => setLimit((current) => current + PAGE_STEP)}
                    className={secondaryButton}
                  >
                    Show {Math.min(PAGE_STEP, items.length - shown.length)} more
                    <span className="sr-only"> wishlist games</span>
                  </button>
                </div>
              ) : null}
              <p className="pt-2 text-xs leading-relaxed text-zinc-500">
                Prices are current US Steam prices. Steam wishlist entries are read-only here:
                watching, notes and removals stay in SteamGauge and are never sent to Steam.
                {payload?.lowsAvailable ? (
                  <>
                    {" "}Historical lows and price history from{" "}
                    <a
                      href="https://isthereanydeal.com/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
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

/** The sort menu above the list, with how many games are shown. */
function SortToolbar({
  sort,
  onSort,
  shown,
  total,
  reviewsPending,
}: {
  sort: WishlistSort;
  onSort: (sort: WishlistSort) => void;
  shown: number;
  total: number;
  reviewsPending: number;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-zinc-800 bg-[#131316] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <label htmlFor={id} className="shrink-0 text-sm font-medium text-zinc-300">
          Sort by
        </label>
        <select
          id={id}
          value={sort}
          onChange={(event: ChangeEvent<HTMLSelectElement>) => {
            if (isWishlistSort(event.target.value)) onSort(event.target.value);
          }}
          className="min-h-11 w-full min-w-0 rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 sm:w-60"
        >
          {WISHLIST_SORTS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p aria-live="polite" className="text-xs text-zinc-500 sm:text-right">
        Showing <span className="tabular-nums text-zinc-300">{shown}</span> of{" "}
        <span className="tabular-nums text-zinc-300">{total}</span>
        {sort === "rating-desc" && reviewsPending > 0
          ? ` · ${reviewsPending} ${reviewsPending === 1 ? "rating" : "ratings"} still loading`
          : null}
      </p>
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
      <p className="flex items-center gap-2 text-sm text-zinc-400">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
        Synced from your Steam wishlist: {fromSteam} {fromSteam === 1 ? "game" : "games"}.
      </p>
    );
  }
  if (payload.steamStatus === "unavailable") {
    return (
      <p className="rounded-2xl border border-zinc-800 bg-[#131316] px-4 py-3 text-sm text-zinc-400">
        Steam could not be reached just now, so only games you watch in SteamGauge are shown.
      </p>
    );
  }
  return (
    <div className="rounded-2xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm leading-relaxed text-zinc-300">
      <p>
        <strong className="font-medium text-amber-200">Steam returned no wishlist.</strong> It is
        either empty or private. Steam shows your wishlist to apps only when your profile&rsquo;s{" "}
        <strong className="font-medium text-zinc-100">Game details</strong> are public.
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

function AddGameForm({
  queryKey,
  full,
  limit,
}: {
  queryKey: readonly unknown[];
  full: boolean;
  limit: number | null;
}) {
  const inputId = useId();
  const messageId = useId();
  const queryClient = useQueryClient();
  const [value, setValue] = useState("");
  const [inputError, setInputError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: (appid: number) => apiSend("POST", "/api/wishlist", { appid }),
    onSuccess: () => {
      setValue("");
      // The deals list shows which games are watched, so refresh it too.
      void queryClient.invalidateQueries({ queryKey: ["deals"] });
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const appid = parseAppReference(value);
    if (appid === null) {
      setInputError("Enter a Steam store link or a numeric App ID.");
      return;
    }
    setInputError(null);
    add.mutate(appid);
  };

  const message = inputError ?? (add.isError ? describeWishlistAddError(add.error, limit) : null);

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="rounded-2xl border border-zinc-800 bg-[#131316] p-4"
    >
      <label htmlFor={inputId} className="text-sm font-medium text-zinc-200">
        Watch a game in SteamGauge
      </label>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          type="text"
          inputMode="url"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={value}
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            setValue(event.target.value);
            setInputError(null);
          }}
          placeholder="store.steampowered.com/app/620 or 620"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          disabled={full}
          className="min-h-11 w-full min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 focus-visible:border-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/40 disabled:cursor-not-allowed disabled:opacity-60"
        />
        <button type="submit" disabled={add.isPending || full} className={primaryButton}>
          {add.isPending ? "Adding…" : "Watch"}
        </button>
      </div>
      {message ? (
        <p id={messageId} role="alert" className="mt-2 text-sm text-rose-300">
          {message}
        </p>
      ) : full ? (
        <p className="mt-2 text-sm text-zinc-400">
          Your SteamGauge watchlist is full{limit ? ` (${limit} games)` : ""}. Stop watching one to
          add another.
        </p>
      ) : null}
    </form>
  );
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
    <li className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c]">
      <div className="flex flex-col sm:flex-row">
        {/* Left column: header image, and the game's facts directly under it. */}
        <div className="shrink-0 sm:m-4 sm:mr-0 sm:w-64 sm:self-start lg:w-72">
        <div className="relative aspect-[460/215] w-full overflow-hidden bg-zinc-900 sm:rounded-xl">
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
            <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#27272a,#18181b)]">
              <span aria-hidden="true" className="text-2xl font-semibold text-zinc-600">
                {item.name.slice(0, 1).toUpperCase()}
              </span>
            </div>
          )}
        </div>
        <div className="border-b border-zinc-800 px-4 py-4 sm:border-b-0 sm:px-0 sm:pb-0">
          <GameFactsPanel appid={item.appid} mode="card" />
        </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-base font-semibold text-zinc-50" title={item.name}>
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
            {item.watched ? <SourceChip tone="emerald">Watching</SourceChip> : null}
            {item.comingSoon ? <SourceChip tone="zinc">Coming soon</SourceChip> : null}
            {item.reviewPercent !== null ? (
              <SourceChip tone="zinc">
                {item.reviewPercent}% positive
                {item.reviewCount ? ` · ${item.reviewCount.toLocaleString("en-US")} reviews` : ""}
              </SourceChip>
            ) : null}
          </div>

          <CurrentPrice item={item} />
          <LowsLine item={item} />

          {item.note ? (
            <p className="mt-2 break-words text-sm text-zinc-400">
              <span className="sr-only">Your note: </span>
              {item.note}
            </p>
          ) : null}

          {item.priceStatus === "free" ? null : (
            <div className="mt-4 border-t border-zinc-800 pt-3">
              <PriceHistoryPanel appid={item.appid} />
            </div>
          )}


          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {item.watched ? (
              <button
                type="button"
                onClick={() => unwatch.mutate()}
                disabled={unwatch.isPending}
                className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
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
            <p className="mt-2 text-xs text-zinc-500">
              To remove it from your Steam wishlist, use Steam. SteamGauge never changes it.
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function SourceChip({ tone, children }: { tone: "violet" | "emerald" | "zinc"; children: ReactNode }) {
  const styles = {
    violet: "bg-violet-400/10 text-violet-300 ring-violet-400/30",
    emerald: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
    zinc: "bg-zinc-800/70 text-zinc-400 ring-zinc-700",
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
      <span className={`${base} bg-zinc-800/60 text-zinc-400 ring-zinc-700`}>
        {item.comingSoon ? "Not released" : "Price unavailable"}
      </span>
    );
  }
  if (item.priceStatus === "free") {
    return <span className={`${base} bg-sky-400/10 text-sky-300 ring-sky-400/30`}>Free to play</span>;
  }
  const percent = item.price?.discountPercent ?? 0;
  return percent > 0 ? (
    <span className={`${base} bg-emerald-400/15 tabular-nums text-emerald-300 ring-emerald-400/40`}>
      On sale -{percent}%
    </span>
  ) : (
    <span className={`${base} bg-zinc-800/60 text-zinc-300 ring-zinc-700`}>Full price</span>
  );
}

function CurrentPrice({ item }: { item: WishlistItem }) {
  if (item.priceStatus !== "priced" || !item.price) return null;
  const { price } = item;
  const ends = item.saleEndsAt ? new Date(item.saleEndsAt) : null;
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-50">
        {formatMoney(price.final, price.currency)}
      </span>
      {price.discountPercent > 0 ? (
        <s className="text-sm tabular-nums text-zinc-500">
          <span className="sr-only">was </span>
          {formatMoney(price.initial, price.currency)}
        </s>
      ) : null}
      {price.discountPercent > 0 && ends && !Number.isNaN(ends.getTime()) ? (
        <span className="text-xs text-zinc-500">
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
    <p className="mt-1 text-xs text-zinc-400">
      {lows.steamLow !== null ? (
        <span>
          Steam all-time low{" "}
          <span className={`font-semibold tabular-nums ${atLow ? "text-emerald-300" : "text-zinc-200"}`}>
            {formatMoney(lows.steamLow, "USD")}
          </span>
          {atLow ? <span className="text-emerald-300"> · at its low now</span> : null}
        </span>
      ) : null}
      {lows.steamLow !== null && lows.yearLowAnyStore !== null ? (
        <span aria-hidden="true" className="mx-1.5 text-zinc-700">·</span>
      ) : null}
      {lows.yearLowAnyStore !== null ? (
        <span>
          1-year low, any store{" "}
          <span className="font-semibold tabular-nums text-zinc-200">
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
          className="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c] sm:flex-row"
        >
          <div className="aspect-[460/215] w-full shrink-0 animate-pulse bg-zinc-900 sm:m-4 sm:mr-0 sm:w-64 sm:self-start sm:rounded-xl lg:w-72" />
          <div className="flex-1 space-y-3 p-4">
            <div className="h-5 w-2/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-7 w-24 animate-pulse rounded bg-zinc-800" />
            <div className="h-28 w-full animate-pulse rounded-md bg-zinc-800/60" />
          </div>
        </div>
      ))}
    </div>
  );
}
