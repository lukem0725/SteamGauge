"use client";

/**
 * components/game-view.tsx
 *
 * The game page (/game/[appid]), reached from the global search.
 *
 *   Header        Header image, title, release, Steam's short description,
 *                 review badge, "Current In-Game Players" badge (v1.12),
 *                 current price, "View on Steam" and "Watch".
 *   Top row       About this game (developer, publisher, franchise, genres,
 *                 tags, features), then Player peaks (24-hour and all-time,
 *                 from IsThereAnyDeal, v1.12), beside the price breakdown
 *                 (lows and every store's price, linked).
 *   Bottom row    Full price history, full width.
 *
 * Data: GET /api/apps/[appid] (store details), GET /api/apps/[appid]/insights
 * and GET /api/wishlist/[appid]/history, all cached on the server for every
 * user.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect } from "react";

import {
  GameFactsPanel,
  PriceHistoryPanel,
  StorePriceList,
  useGameInsights,
} from "@/components/game-insights";
import { pageContainer } from "@/components/layout-width";
import { LivePlayersBadge, PlayerPeaksPanel, type FigureState } from "@/components/player-metrics";
import { ReviewBadge } from "@/components/review-badge";
import {
  StatePanel,
  describeWishlistAddError,
  formatMoney,
  primaryButton,
  secondaryButton,
} from "@/components/ui-kit";
import { apiGet, apiSend } from "@/lib/api/client";
import type { GameInsights } from "@/lib/game-insights";
import type { AppDetails } from "@/lib/steam/endpoints";
import type { ReviewSummary } from "@/lib/steam/reviews";

export function GameView({ appid }: { appid: number }) {
  const details = useQuery({
    queryKey: ["app", "details", appid],
    queryFn: ({ signal }) => apiGet<AppDetails>(`/api/apps/${appid}`, signal),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const insights = useGameInsights(appid, "full", true);
  const app = details.data?.status === "ok" ? details.data.data : null;

  useEffect(() => {
    if (app) document.title = `${app.name} · SteamGauge`;
  }, [app]);

  return (
    <div className="bg-page text-slate-100 antialiased">
      <main className={pageContainer}>
        {details.isPending ? (
          <GameSkeleton />
        ) : details.isError ? (
          <StatePanel
            tone="rose"
            title="This game could not be loaded"
            actions={
              <button type="button" onClick={() => void details.refetch()} className={secondaryButton}>
                Try again
              </button>
            }
          >
            Steam did not answer just now. Your search results are still there; try again in a moment.
          </StatePanel>
        ) : !app ? (
          <StatePanel
            tone="neutral"
            title="Steam has no game with this ID"
            actions={
              <Link href="/deals" className={secondaryButton}>
                Browse deals
              </Link>
            }
          >
            Try the search box at the top to find it by name.
          </StatePanel>
        ) : (
          <>
            <GameHeader
              app={app}
              players={insights.data?.status === "ok" ? insights.data.data.players : null}
              playersState={
                insights.isPending
                  ? "loading"
                  : insights.data?.status === "ok" && !insights.data.data.unavailable.includes("players")
                    ? "ready"
                    : "unavailable"
              }
              reviews={insights.data?.status === "ok" ? insights.data.data.reviews : null}
              reviewState={
                insights.isPending
                  ? "loading"
                  : insights.data?.status === "ok" && !insights.data.data.unavailable.includes("reviews")
                    ? "ready"
                    : "unavailable"
              }
            />
            <section aria-label="Game details" className="mt-5 rounded-3xl border border-slate-800 bg-surface p-4 sm:p-6">
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div className="min-w-0">
                  {/* The live count is in the header badge, so the facts leave it out. */}
                  <GameFactsPanel appid={appid} mode="full" insights={insights} maxFeatures={8} showPlayers={false} />
                  <PlayerPeaksPanel
                    peaks={insights.data?.status === "ok" ? insights.data.data.playerPeaks : null}
                    state={
                      insights.isPending
                        ? "loading"
                        : insights.data?.status === "ok" && !insights.data.data.unavailable.includes("playerPeaks")
                          ? "ready"
                          : "unavailable"
                    }
                  />
                </div>
                <div className="min-w-0">
                  {insights.isPending ? (
                    <div aria-busy="true" aria-label="Loading store prices" className="h-24 animate-pulse rounded-lg bg-slate-800/60" />
                  ) : (
                    <StorePriceList
                      data={insights.data?.status === "ok" ? insights.data.data.prices : null}
                      steamPrice={app.price?.final ?? 0}
                      unavailable={insights.data?.status !== "ok" || insights.data.data.unavailable.includes("prices")}
                    />
                  )}
                </div>
              </div>
              {app.isFree ? null : (
                <div className="mt-6 border-t border-slate-800 pt-4">
                  <PriceHistoryPanel appid={appid} eager />
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function GameHeader({
  app,
  players,
  playersState,
  reviews,
  reviewState,
}: {
  app: AppDetails;
  players: GameInsights["players"];
  playersState: FigureState;
  reviews: ReviewSummary | null;
  reviewState: "loading" | "ready" | "unavailable";
}) {
  return (
    <header className="overflow-hidden rounded-3xl border border-slate-800 bg-surface">
      <div className="flex flex-col gap-5 p-4 sm:flex-row sm:p-6">
        {app.headerImage ? (
          // Steam CDN image; a plain <img> avoids next/image remote configuration.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={app.headerImage}
            alt=""
            width={460}
            height={215}
            decoding="async"
            className="aspect-[460/215] w-full shrink-0 rounded-2xl bg-slate-900 object-cover sm:w-80 lg:w-[23rem]"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="text-xs font-medium uppercase tracking-wider text-steam-300">
            {app.type === "dlc" ? "DLC" : app.type === "game" ? "Game" : app.type}
            {" · "}
            {app.releaseDate.comingSoon ? "Coming soon" : app.releaseDate.display ?? "Release date unknown"}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">{app.name}</h1>
          {app.shortDescription ? (
            <p className="mt-2 line-clamp-3 max-w-3xl text-sm leading-relaxed text-slate-300">{app.shortDescription}</p>
          ) : null}
          {/* Steam's rating and the live player count, right under the title (v1.11, v1.12). */}
          <div className="mt-3 flex flex-col items-start gap-2">
            <ReviewBadge summary={reviews} state={reviewState} />
            <LivePlayersBadge players={players} state={playersState} />
          </div>
          <div className="mt-auto flex flex-wrap items-end justify-between gap-4 pt-4">
            <PriceBlock app={app} />
            <div className="flex flex-wrap gap-2">
              <a
                href={`https://store.steampowered.com/app/${app.appid}/`}
                target="_blank"
                rel="noopener noreferrer"
                className={primaryButton}
              >
                View on Steam
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <WatchButton appid={app.appid} name={app.name} />
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}

function PriceBlock({ app }: { app: AppDetails }) {
  if (app.isFree) return <p className="text-2xl font-semibold text-slate-50">Free to play</p>;
  if (!app.price) return <p className="text-sm text-slate-400">Not sold in the US store right now.</p>;
  const { price } = app;
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      {price.discountPercent > 0 ? (
        <span className="rounded-md bg-steam-400/15 px-2 py-0.5 text-sm font-semibold tabular-nums text-steam-300">
          -{price.discountPercent}%
        </span>
      ) : null}
      <span className="text-2xl font-semibold tabular-nums text-slate-50">{formatMoney(price.final, price.currency)}</span>
      {price.discountPercent > 0 ? (
        <span className="text-sm tabular-nums text-slate-500 line-through">{formatMoney(price.initial, price.currency)}</span>
      ) : null}
    </p>
  );
}

/** Adds the game to the SteamGauge watchlist (never to the Steam wishlist). */
function WatchButton({ appid, name }: { appid: number; name: string }) {
  const queryClient = useQueryClient();
  const watch = useMutation({
    mutationFn: () => apiSend("POST", "/api/wishlist", { appid }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["deals"] });
    },
  });
  if (watch.isSuccess) {
    return (
      <Link href="/wishlist" className={secondaryButton}>
        ✓ Watching · Open wishlist
      </Link>
    );
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <button type="button" onClick={() => watch.mutate()} disabled={watch.isPending} className={secondaryButton}>
        {watch.isPending ? "Adding…" : "Watch"}
        <span className="sr-only"> {name} in SteamGauge</span>
      </button>
      {watch.isError ? (
        <p role="alert" className="text-xs text-rose-300">
          {describeWishlistAddError(watch.error, null)}
        </p>
      ) : null}
    </div>
  );
}

function GameSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading game" className="space-y-5">
      <div className="h-56 animate-pulse rounded-3xl border border-slate-800 bg-surface" />
      <div className="h-80 animate-pulse rounded-3xl border border-slate-800 bg-surface" />
    </div>
  );
}
