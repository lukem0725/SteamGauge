"use client";

/**
 * components/deals-view.tsx
 *
 * The "Bang for Your Buck" deals ranking. One request to GET /api/deals
 * returns trending discounted games already scored and sorted by cost per
 * hour, with a backlog cross-reference for the signed-in user.
 *
 * A yellow warning badge appears on a deal when the user does not own the
 * game but already has unplayed games in one of its genres.
 *
 * Mobile-first: laid out for a 360px portrait screen, widening at sm/lg.
 * Only types are imported from server-only modules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";

import {
  DataAgeTicker,
  ErrorState,
  StatePanel,
  VALUE_TONE,
  ValueMeter,
  describeWishlistAddError,
  formatMoney,
  primaryButton,
  secondaryButton,
} from "@/components/ui-kit";
import { apiGet, apiSend } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import type { Deal, DealsBacklogSummary, DealsPayload } from "@/lib/deals";

/** After a stale answer, re-check this many times for the refreshed data. */
const STALE_RECHECK_LIMIT = 2;
const STALE_RECHECK_MS = 4_000;

const STEAM_PRIVACY_SETTINGS_URL = "https://steamcommunity.com/my/edit/settings";

// =============================================================================
// Entry point
// =============================================================================

export interface DealsViewProps {
  /** The verified session user, from the Server Component. */
  readonly user: SessionUser;
}

export function DealsView({ user }: DealsViewProps) {
  return <Deals user={user} />;
}

function Deals({ user }: DealsViewProps) {
  const deals = useQuery({
    // Keyed by user: owned flags and backlog warnings are personal.
    queryKey: ["deals", user.steamid],
    queryFn: ({ signal }) => apiGet<DealsPayload>("/api/deals", signal),
    staleTime: 5 * 60_000,
    // Bounded follow-up after a stale answer, not polling (doc 4.1).
    refetchInterval: (query) =>
      query.state.data?.meta.stale && query.state.dataUpdateCount <= STALE_RECHECK_LIMIT
        ? STALE_RECHECK_MS
        : false,
  });

  const result = deals.data;
  const payload = result?.status === "ok" ? result.data : null;

  return (
    <div className="bg-zinc-950 text-zinc-100 antialiased">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-5 sm:px-6 lg:px-8">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-50">
              Bang for your buck
            </h1>
            <p className="mt-1 text-sm text-zinc-400">
              Trending Steam discounts, ranked by cost per hour.
            </p>
          </div>
          <div className="pt-1">
            <DataAgeTicker meta={result?.meta ?? null} isFetching={deals.isFetching} />
          </div>
        </header>

        <main className="mt-6 space-y-4">
          {deals.isPending ? (
            <DealsSkeleton />
          ) : deals.isError ? (
            <ErrorState
              error={deals.error}
              onRetry={() => void deals.refetch()}
              retrying={deals.isFetching}
              subject="today's deals"
            />
          ) : !payload || payload.deals.length === 0 ? (
            <StatePanel tone="neutral" title="No featured discounts right now">
              <p>
                Steam is not featuring any discounted games at the moment. The list is refreshed
                about once an hour.
              </p>
            </StatePanel>
          ) : (
            <>
              <BacklogNotice backlog={payload.backlog} />
              <ol aria-label="Deals ranked by cost per hour, best first" className="space-y-3">
                {payload.deals.map((deal) => (
                  <DealRow key={deal.appid} deal={deal} steamid={user.steamid} />
                ))}
              </ol>
              <p className="pt-2 text-xs leading-relaxed text-zinc-500">
                Cost per hour is the sale price divided by game length. Length is a simulated
                placeholder, not real completion data, so treat the ranking as illustrative.
                Prices are current US store prices.
              </p>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// Backlog notice
// =============================================================================

/** Explains what the yellow badges are based on, or why there are none. */
function BacklogNotice({ backlog }: { backlog: DealsBacklogSummary }) {
  const shell = "rounded-2xl border px-4 py-3 text-sm leading-relaxed";

  if (backlog.status === "private") {
    return (
      <p className={`${shell} border-zinc-800 bg-[#131316] text-zinc-400`}>
        Backlog warnings are off because your Steam game details are private.{" "}
        <a
          href={STEAM_PRIVACY_SETTINGS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-zinc-200 underline decoration-zinc-600 underline-offset-2 hover:decoration-zinc-400"
        >
          Change privacy settings
        </a>
      </p>
    );
  }

  if (backlog.status === "unavailable") {
    return (
      <p className={`${shell} border-zinc-800 bg-[#131316] text-zinc-400`}>
        We could not load your library just now, so backlog warnings are not shown.
      </p>
    );
  }

  if (backlog.unplayedCount === 0) {
    return (
      <p className={`${shell} border-emerald-400/20 bg-emerald-400/5 text-emerald-200`}>
        Your backlog is empty, so nothing here competes with games you already own.
      </p>
    );
  }

  const partial = backlog.analyzedCount < backlog.unplayedCount;
  return (
    <p className={`${shell} border-yellow-400/25 bg-yellow-400/5 text-zinc-300`}>
      <span className="font-medium text-yellow-200">
        You own {backlog.unplayedCount} unplayed {backlog.unplayedCount === 1 ? "game" : "games"}.
      </span>{" "}
      A yellow badge marks a deal in a genre you already have waiting.
      {partial ? (
        <span className="text-zinc-500">
          {" "}
          Based on {backlog.analyzedCount} of your {backlog.unplayedCount} unplayed games.
        </span>
      ) : null}
    </p>
  );
}

// =============================================================================
// One ranked deal
// =============================================================================

function DealRow({ deal, steamid }: { deal: Deal; steamid: string }) {
  const tone = VALUE_TONE[deal.valueLevel];
  const isFree = deal.finalPrice === 0;

  return (
    <li className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c]">
      <div className="flex flex-col sm:flex-row">
        {/* Artwork with the rank over it */}
        <div className="relative aspect-[460/215] w-full shrink-0 overflow-hidden bg-zinc-900 sm:m-4 sm:mr-0 sm:w-60 sm:self-start sm:rounded-xl">
          {deal.headerImage ? (
            // Steam CDN image; a plain <img> avoids next/image remote configuration.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={deal.headerImage}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full min-h-24 w-full items-center justify-center bg-[linear-gradient(135deg,#27272a,#18181b)]">
              <span aria-hidden="true" className="text-2xl font-semibold text-zinc-600">
                {deal.name.slice(0, 1).toUpperCase()}
              </span>
            </div>
          )}
          <span className="absolute left-2 top-2 flex h-8 min-w-8 items-center justify-center rounded-full bg-zinc-950/85 px-2 text-sm font-bold tabular-nums text-zinc-100 ring-1 ring-zinc-700">
            <span className="sr-only">Rank </span>
            {deal.rank}
          </span>
          <span className="absolute right-2 top-2 rounded-md bg-emerald-400 px-1.5 py-0.5 text-xs font-bold tabular-nums text-zinc-950">
            -{deal.discountPercent}%
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-4">
          <h2 className="truncate text-base font-semibold text-zinc-50" title={deal.name}>
            {deal.name}
          </h2>

          {/* Badges */}
          {deal.backlogMatches || deal.owned ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {deal.backlogMatches ? <BacklogWarningBadge deal={deal} /> : null}
              {deal.owned ? (
                <span className="inline-flex items-center rounded-full bg-sky-400/10 px-2.5 py-1 text-xs font-medium text-sky-300 ring-1 ring-sky-400/30">
                  Already in your library
                </span>
              ) : null}
            </div>
          ) : null}

          {/* Score */}
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className={`text-sm font-semibold ${tone.text}`}>
                {isFree ? "Free right now" : deal.valueLabel}
              </p>
              <p className="text-lg font-semibold tabular-nums text-zinc-50">
                {formatMoney(deal.centsPerHour, deal.currency)}
                <span className="text-sm font-normal text-zinc-500">/hr</span>
              </p>
            </div>
            <ValueMeter level={deal.valueLevel} bar={tone.bar} />
          </div>

          {/* Price and length */}
          <p className="mt-3 text-sm text-zinc-400">
            <span className="font-semibold tabular-nums text-zinc-100">
              {formatMoney(deal.finalPrice, deal.currency)}
            </span>{" "}
            <s className="tabular-nums text-zinc-500">
              <span className="sr-only">was </span>
              {formatMoney(deal.originalPrice, deal.currency)}
            </s>
            <span className="mx-1.5 text-zinc-700" aria-hidden="true">
              ·
            </span>
            ~{deal.estimatedHours}h <span className="text-zinc-600">(simulated)</span>
          </p>

          {deal.genres && deal.genres.length > 0 ? (
            <ul aria-label="Genres" className="mt-3 flex flex-wrap gap-1.5">
              {deal.genres.slice(0, 4).map((genre) => (
                <li
                  key={genre}
                  className="rounded-md bg-zinc-800/80 px-2 py-0.5 text-[11px] font-medium text-zinc-400"
                >
                  {genre}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            {/* Nothing to watch for on a game the user already owns. */}
            {deal.owned ? null : <WatchButton deal={deal} steamid={steamid} />}
            <a
              href={`https://store.steampowered.com/app/${deal.appid}`}
              target="_blank"
              rel="noopener noreferrer"
              className={secondaryButton}
            >
              View on Steam
              <span className="sr-only"> (opens in a new tab): {deal.name}</span>
            </a>
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * "Watch this game" adds the deal to the wishlist in one tap. Once watched
 * (already, or just now) it becomes an "In wishlist" link to that page.
 */
function WatchButton({ deal, steamid }: { deal: Deal; steamid: string }) {
  const queryClient = useQueryClient();
  const watch = useMutation({
    mutationFn: () => apiSend("POST", "/api/wishlist", { appid: deal.appid }),
    // The wishlist page must show the new game next time it is opened.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["wishlist", steamid] }),
  });

  if (deal.watched || watch.isSuccess) {
    return (
      <Link
        href="/wishlist"
        className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-emerald-400/40 bg-emerald-400/10 px-4 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-400/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
          <path
            fillRule="evenodd"
            clipRule="evenodd"
            d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4L8.5 12l6.8-6.7a1 1 0 0 1 1.4 0Z"
          />
        </svg>
        In wishlist
        <span className="sr-only">: {deal.name}. Open your wishlist</span>
      </Link>
    );
  }

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => watch.mutate()}
        disabled={watch.isPending}
        className={primaryButton}
      >
        {watch.isPending ? "Adding…" : "Watch this game"}
        <span className="sr-only">: {deal.name}</span>
      </button>
      {watch.isError ? (
        <p role="alert" className="mt-2 max-w-xs text-sm text-rose-300">
          {describeWishlistAddError(watch.error, null)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The yellow backlog warning. Names the most crowded matching genre, with
 * the full list in the tooltip and for screen readers.
 */
function BacklogWarningBadge({ deal }: { deal: Deal }) {
  const matches = deal.backlogMatches ?? [];
  const top = matches[0];
  if (!top) return null;

  const detail = matches
    .map((match) => `${match.unplayedCount} unplayed ${match.genre}`)
    .join(", ");

  return (
    <span
      title={`In your backlog: ${detail}`}
      className="inline-flex items-center gap-1.5 rounded-full bg-yellow-400/15 px-2.5 py-1 text-xs font-semibold text-yellow-300 ring-1 ring-yellow-400/40"
    >
      <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M8.49 2.86c.67-1.15 2.35-1.15 3.02 0l6.26 10.75c.67 1.15-.17 2.6-1.51 2.6H3.74c-1.34 0-2.18-1.45-1.51-2.6L8.49 2.86ZM10 7a.75.75 0 0 1 .75.75v3a.75.75 0 0 1-1.5 0v-3A.75.75 0 0 1 10 7Zm0 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        />
      </svg>
      <span>
        <span className="sr-only">Backlog warning: </span>
        You have {top.unplayedCount} unplayed {top.genre}{" "}
        {top.unplayedCount === 1 ? "game" : "games"}
        {matches.length > 1 ? <span className="sr-only">. All matches: {detail}</span> : null}
      </span>
    </span>
  );
}

// =============================================================================
// Loading state
// =============================================================================

function DealsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading deals" className="space-y-3">
      <div className="h-12 animate-pulse rounded-2xl bg-zinc-900" />
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c] sm:flex-row"
        >
          <div className="aspect-[460/215] w-full shrink-0 animate-pulse bg-zinc-900 sm:m-4 sm:mr-0 sm:w-60 sm:self-start sm:rounded-xl" />
          <div className="flex-1 space-y-3 p-4">
            <div className="h-5 w-2/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-4 w-1/3 animate-pulse rounded bg-zinc-800" />
            <div className="h-1.5 w-full animate-pulse rounded-full bg-zinc-800" />
            <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800" />
          </div>
        </div>
      ))}
    </div>
  );
}
