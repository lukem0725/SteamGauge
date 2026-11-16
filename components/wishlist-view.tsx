"use client";

/**
 * components/wishlist-view.tsx
 *
 * The personal price watchlist.
 *
 *   GET    /api/wishlist                   tracked games with current prices
 *   POST   /api/wishlist                   track a game
 *   DELETE /api/wishlist/[appid]           stop tracking
 *   GET    /api/wishlist/[appid]/history   recorded prices, loaded per card
 *                                          once that card scrolls into view
 *
 * Mobile-first: laid out for a 360px portrait screen, widening at sm/lg.
 * Only types are imported from server-only modules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState, type ChangeEvent, type FormEvent } from "react";

import { PriceHistoryChart, formatDay } from "@/components/price-history-chart";
import {
  DataAgeTicker,
  ErrorState,
  StatePanel,
  describeWishlistAddError,
  formatMoney,
  primaryButton,
  secondaryButton,
  useInViewOnce,
} from "@/components/ui-kit";
import { apiGet, apiSend } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import type { PriceHistory } from "@/lib/price-history";
import type { WishlistItem, WishlistPayload } from "@/lib/wishlist";

/** After a stale answer, re-check this many times for the refreshed data. */
const STALE_RECHECK_LIMIT = 2;
const STALE_RECHECK_MS = 4_000;

/** Must match MIN_DAYS_FOR_LOW_CLAIM in lib/price-history.ts. */
const DAYS_NEEDED_FOR_LOW = 7;

// =============================================================================
// Entry point
// =============================================================================

export interface WishlistViewProps {
  /** The verified session user, from the Server Component. */
  readonly user: SessionUser;
}

export function WishlistView({ user }: WishlistViewProps) {
  return <Wishlist user={user} />;
}

function Wishlist({ user }: WishlistViewProps) {
  const queryKey = ["wishlist", user.steamid] as const;

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
  const items = payload ? sortForDisplay(payload.items) : [];
  const onSale = items.filter(isOnSale).length;

  return (
    <div className="bg-zinc-950 text-zinc-100 antialiased">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-5 sm:px-6 lg:px-8">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">Wishlist</h1>
            <p className="mt-1 text-sm text-zinc-400">
              {payload && items.length > 0
                ? `${onSale} of ${items.length} on sale right now.`
                : "Games you are watching for a price drop."}
            </p>
          </div>
          <div className="pt-1">
            <DataAgeTicker meta={result?.meta ?? null} isFetching={wishlist.isFetching} />
          </div>
        </header>

        <main className="mt-6 space-y-4">
          <AddGameForm
            queryKey={queryKey}
            full={payload !== null && items.length >= payload.limit}
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
                Paste a Steam store link or an App ID above to start watching a game. We check
                its price every day and show you when it drops.
              </p>
            </StatePanel>
          ) : (
            <>
              <ul aria-label="Watched games" className="space-y-3">
                {items.map((item) => (
                  <WishlistCard key={item.appid} item={item} queryKey={queryKey} />
                ))}
              </ul>
              <p className="pt-2 text-xs leading-relaxed text-zinc-500">
                Prices are current US store prices. History is what SteamLite has recorded since
                it first saw each game, so &ldquo;lowest recorded&rdquo; is not the lowest price
                the game has ever had.
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function isOnSale(item: WishlistItem): boolean {
  return item.priceStatus === "priced" && (item.price?.discountPercent ?? 0) > 0;
}

/** Discounted games first, deepest discount on top; the rest keep server order (newest first). */
function sortForDisplay(items: readonly WishlistItem[]): WishlistItem[] {
  return [...items].sort(
    (a, b) =>
      Number(isOnSale(b)) - Number(isOnSale(a)) ||
      (b.price?.discountPercent ?? 0) - (a.price?.discountPercent ?? 0),
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
        Watch a game
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
          {add.isPending ? "Adding…" : "Add to wishlist"}
        </button>
      </div>
      {message ? (
        <p id={messageId} role="alert" className="mt-2 text-sm text-rose-300">
          {message}
        </p>
      ) : full ? (
        <p className="mt-2 text-sm text-zinc-400">
          Your wishlist is full{limit ? ` (${limit} games)` : ""}. Remove one to add another.
        </p>
      ) : null}
    </form>
  );
}

// =============================================================================
// One watched game
// =============================================================================

function WishlistCard({ item, queryKey }: { item: WishlistItem; queryKey: readonly unknown[] }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => apiSend("DELETE", `/api/wishlist/${item.appid}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["deals"] });
      return queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <li className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c]">
      <div className="flex flex-col sm:flex-row">
        <div className="relative aspect-[460/215] w-full shrink-0 overflow-hidden bg-zinc-900 sm:m-4 sm:mr-0 sm:w-60 sm:self-start sm:rounded-xl">
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

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-base font-semibold text-zinc-50" title={item.name}>
              {item.name}
            </h2>
            <DiscountBadge item={item} />
          </div>

          <CurrentPrice item={item} />

          {item.note ? (
            <p className="mt-2 break-words text-sm text-zinc-400">
              <span className="sr-only">Your note: </span>
              {item.note}
            </p>
          ) : null}

          {item.priceStatus === "free" ? null : <PriceHistoryPanel appid={item.appid} />}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <a
              href={`https://store.steampowered.com/app/${item.appid}`}
              target="_blank"
              rel="noopener noreferrer"
              className={secondaryButton}
            >
              View on Steam
              <span className="sr-only"> (opens in a new tab): {item.name}</span>
            </a>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {remove.isPending ? "Removing…" : "Remove"}
              <span className="sr-only"> {item.name} from wishlist</span>
            </button>
          </div>
          {remove.isError ? (
            <p role="alert" className="mt-2 text-sm text-rose-300">
              Could not remove this game. Try again.
            </p>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/** Discount status as a labelled badge, never colour alone. */
function DiscountBadge({ item }: { item: WishlistItem }) {
  const base = "shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ring-1";
  if (item.priceStatus === "unavailable") {
    return <span className={`${base} bg-zinc-800/60 text-zinc-400 ring-zinc-700`}>Price unavailable</span>;
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
  return (
    <p className="mt-2 flex items-baseline gap-2">
      <span className="text-2xl font-semibold tabular-nums tracking-tight text-zinc-50">
        {formatMoney(price.final, price.currency)}
      </span>
      {price.discountPercent > 0 ? (
        <s className="text-sm tabular-nums text-zinc-500">
          <span className="sr-only">was </span>
          {formatMoney(price.initial, price.currency)}
        </s>
      ) : null}
    </p>
  );
}

// =============================================================================
// Price history
// =============================================================================

function PriceHistoryPanel({ appid }: { appid: number }) {
  const [ref, inView] = useInViewOnce<HTMLDivElement>();

  const history = useQuery({
    queryKey: ["wishlist", "history", appid],
    queryFn: ({ signal }) => apiGet<PriceHistory>(`/api/wishlist/${appid}/history`, signal),
    enabled: inView,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const data = history.data?.status === "ok" ? history.data.data : null;

  return (
    <div ref={ref} className="mt-4 border-t border-zinc-800 pt-3">
      <h3 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Price history</h3>
      {!inView || history.isPending ? (
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
 * States plainly whether the current price is the lowest SteamLite has
 * recorded. The claim is only made with a week or more of history; before
 * that, any price is trivially the "lowest" and saying so would mislead.
 */
export function LowStatusLine({ history }: { history: PriceHistory }) {
  const currency = history.currency ?? "USD";
  const since = history.firstObservedOn ? formatDay(history.firstObservedOn) : null;

  if (history.lowStatus === "at_low" && history.lowest) {
    return (
      <p className="mt-2 flex items-start gap-2 text-sm text-zinc-200">
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="#0ca30c"
          className="mt-0.5 h-4 w-4 shrink-0"
        >
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.7-9.3a1 1 0 0 0-1.4-1.4L9 10.6 7.7 9.3a1 1 0 0 0-1.4 1.4l2 2a1 1 0 0 0 1.4 0l4-4Z"
          />
        </svg>
        <span>
          <strong className="font-semibold text-zinc-50">Lowest price we have recorded.</strong>{" "}
          <span className="text-zinc-400">
            {history.observedDays} days tracked{since ? `, since ${since}` : ""}.
          </span>
        </span>
      </p>
    );
  }

  if (history.lowStatus === "above_low" && history.lowest && history.currentFinal !== null) {
    const above = history.currentFinal - history.lowest.final;
    return (
      <p className="mt-2 text-sm text-zinc-300">
        <strong className="font-semibold text-zinc-100">Not the lowest we have recorded.</strong>{" "}
        <span className="text-zinc-400">
          It was {formatMoney(history.lowest.final, currency)} on {formatDay(history.lowest.date)},{" "}
          {formatMoney(above, currency)} less than now.
        </span>
      </p>
    );
  }

  if (history.lowStatus === "insufficient_history") {
    return (
      <p className="mt-2 text-sm text-zinc-400">
        {since ? `Tracking since ${since}. ` : "Tracking has just started. "}
        {history.observedDays} of {DAYS_NEEDED_FOR_LOW} days recorded before we can call a low.
      </p>
    );
  }

  return <p className="mt-2 text-sm text-zinc-400">This game has no price to compare right now.</p>;
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
          <div className="aspect-[460/215] w-full shrink-0 animate-pulse bg-zinc-900 sm:m-4 sm:mr-0 sm:w-60 sm:self-start sm:rounded-xl" />
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
