"use client";

/**
 * components/game-card.tsx
 *
 * The two card sizes for the Dashboard library (v1.10), used by all three
 * sections (All games, Lifetime hours, Unplayed backlog):
 *
 *   DetailedGameCard  header art, playtime, release year, last played, top
 *                     tags, current price and, for unplayed games, the
 *                     backlog value meter
 *   CompactGameRow    one dense row: icon, title, playtime, price
 *
 * In both, the game's title links to its SteamGauge page (/game/[appid]),
 * the same page the search in the top bar opens. The compact row's link
 * covers the whole row, for an easy tap target. The detailed card keeps a
 * separate "View on Steam" link, so only the title opens the game page.
 *
 * Store-based fields (art, release date, price, tags) come from
 * GET /api/library/store, which loads after the library; `store` is null
 * until it arrives and for games it does not cover.
 *
 * Cards make no requests of their own.
 */
import Link from "next/link";
import { useState } from "react";

import { VALUE_TONE, ValueMeter, formatMoney } from "@/components/ui-kit";
import type { LibraryGameStore } from "@/lib/library-view";
import type { AppPrice, OwnedGame } from "@/lib/steam/endpoints";
import { costPerHour, rateValue, simulatedHoursToBeat } from "@/lib/value";

/** Whether store data has loaded for the library (not for one game). */
export type StoreState = "loading" | "ready" | "unavailable";

export interface GameCardProps {
  readonly game: OwnedGame;
  /** Place by playtime among all owned games; shown only when `showRank`. */
  readonly rank: number;
  readonly showRank: boolean;
  readonly store: LibraryGameStore | null;
  readonly storeState: StoreState;
}

/** The game's page in SteamGauge, as opened from the search in the top bar. */
export function gameHref(appid: number): string {
  return `/game/${appid}`;
}

// =============================================================================
// Small pieces
// =============================================================================

const hoursFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

export function formatPlaytime(minutes: number): string {
  if (minutes === 0) return "Never played";
  if (minutes < 60) return `${minutes} min`;
  return `${hoursFormat.format(minutes / 60)} h`;
}

function lastPlayedText(game: OwnedGame): string {
  if (!game.lastPlayedAt) return game.playtimeMinutes === 0 ? "Never played" : "No play date recorded";
  const date = new Date(game.lastPlayedAt);
  return Number.isNaN(date.getTime()) ? "No play date recorded" : `Last played ${monthYear.format(date)}`;
}

function releaseText(store: LibraryGameStore | null): string | null {
  if (!store) return null;
  if (store.comingSoon) return "Coming soon";
  return store.releaseDate ? store.releaseDate.slice(0, 4) : null;
}

/** The current price: discounted with the regular price struck out, free, or not sold. */
function PriceTag({
  store,
  storeState,
  size = "sm",
}: {
  store: LibraryGameStore | null;
  storeState: StoreState;
  size?: "sm" | "xs";
}) {
  const text = size === "sm" ? "text-sm" : "text-xs";
  if (storeState === "loading" && !store) {
    return <span aria-label="Loading price" className="inline-block h-3 w-12 animate-pulse rounded bg-slate-800" />;
  }
  if (!store) return <span className={`${text} text-slate-500`}>Price unknown</span>;
  if (store.isFree) return <span className={`${text} font-semibold text-steam-300`}>Free</span>;
  if (store.priceFinal === null) return <span className={`${text} text-slate-500`}>Not sold</span>;
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-1.5 ${text}`}>
      {store.discountPercent > 0 ? (
        <span className="rounded bg-steam-400/15 px-1 text-[11px] font-semibold text-steam-300">
          -{store.discountPercent}%
        </span>
      ) : null}
      <span className="font-semibold tabular-nums text-slate-100">{formatMoney(store.priceFinal, "USD")}</span>
      {store.discountPercent > 0 && store.priceInitial !== null ? (
        // Compact rows on phones keep the badge and price only.
        <span className={`text-xs tabular-nums text-slate-500 line-through ${size === "xs" ? "hidden sm:inline" : ""}`}>
          {formatMoney(store.priceInitial, "USD")}
        </span>
      ) : null}
    </span>
  );
}

/** Header art, falling back to the icon on a gradient when there is none or it fails. */
function CardArt({ game, store, storeState }: { game: OwnedGame; store: LibraryGameStore | null; storeState: StoreState }) {
  const [failed, setFailed] = useState(false);
  const src = store?.headerImage ?? null;
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
        className="h-full w-full object-cover"
      />
    );
  }
  return (
    <div
      className={`flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#1e2836,#121822)] ${
        storeState === "loading" ? "animate-pulse" : ""
      }`}
    >
      {game.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={game.iconUrl} alt="" width={32} height={32} loading="lazy" className="h-8 w-8 rounded" />
      ) : (
        <span aria-hidden="true" className="text-2xl font-semibold text-slate-600">
          {game.name.slice(0, 1).toUpperCase()}
        </span>
      )}
    </div>
  );
}

function valueStateOf(store: LibraryGameStore | null, storeState: StoreState): ValueState {
  if (!store) return storeState === "loading" ? { kind: "loading" } : { kind: "unavailable" };
  if (store.isFree) return { kind: "free" };
  if (store.priceFinal === null) return { kind: "unavailable" };
  return {
    kind: "priced",
    price: {
      currency: "USD",
      initial: store.priceInitial ?? store.priceFinal,
      final: store.priceFinal,
      discountPercent: store.discountPercent,
      finalFormatted: null,
    },
  };
}

// =============================================================================
// Detailed card
// =============================================================================

export function DetailedGameCard({ game, rank, showRank, store, storeState }: GameCardProps) {
  const unplayed = game.playtimeMinutes === 0;
  const release = releaseText(store);
  return (
    <li className="relative flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-surface-raised">
      <div className="relative aspect-[460/215] w-full bg-slate-900">
        <CardArt game={game} store={store} storeState={storeState} />
        <span
          className={`absolute left-2 top-2 rounded-full bg-chrome/85 px-2 py-0.5 text-[11px] font-medium ring-1 ${
            unplayed ? "text-amber-300 ring-amber-400/30" : "text-steam-200 ring-steam-400/30"
          }`}
        >
          {unplayed ? "0h played" : `${formatPlaytime(game.playtimeMinutes)} played`}
        </span>
        {showRank ? (
          <span className="absolute right-2 top-2 rounded-full bg-chrome/85 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-200 ring-1 ring-slate-600/50">
            <span className="sr-only">Rank by playtime </span>#{rank}
          </span>
        ) : null}
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-sm font-semibold leading-snug text-slate-100">
          <Link
            href={gameHref(game.appid)}
            title={game.name}
            className="line-clamp-2 rounded hover:text-steam-300 hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
          >
            {game.name}
          </Link>
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          {release ? `${release} · ` : ""}
          {lastPlayedText(game)}
        </p>

        {store && store.tags.length > 0 ? (
          <ul aria-label="Top tags" className="mt-2 flex flex-wrap gap-1">
            {store.tags.slice(0, 3).map((tag, index) => (
              <li
                key={`${tag}-${index}`}
                className="rounded bg-slate-800/80 px-1.5 py-0.5 text-[11px] text-slate-300"
              >
                {tag}
              </li>
            ))}
          </ul>
        ) : storeState === "loading" ? (
          <div className="mt-2 h-4 w-32 animate-pulse rounded bg-slate-800" />
        ) : null}

        <div className="mt-3 flex-1">
          {unplayed ? (
            <ValueIndicator hours={simulatedHoursToBeat(game.appid)} state={valueStateOf(store, storeState)} />
          ) : (
            <p className="text-xs text-slate-400">
              <span className="sr-only">Current price: </span>
              <PriceTag store={store} storeState={storeState} />
            </p>
          )}
        </div>

        <a
          href={`https://store.steampowered.com/app/${game.appid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 px-3 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
        >
          View on Steam
          <span className="sr-only"> (opens in a new tab): {game.name}</span>
        </a>
      </div>
    </li>
  );
}

// =============================================================================
// Compact row
// =============================================================================

export function CompactGameRow({ game, rank, showRank, store, storeState }: GameCardProps) {
  const release = releaseText(store);
  const firstTag = store?.tags[0] ?? null;
  return (
    <li className="relative flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 bg-surface-raised px-3 py-2 transition-colors hover:border-slate-700">
      {showRank ? (
        <span className="w-7 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-500">
          <span className="sr-only">Rank by playtime </span>
          {rank}
        </span>
      ) : null}
      {game.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={game.iconUrl} alt="" width={32} height={32} loading="lazy" className="h-8 w-8 shrink-0 rounded" />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-slate-800 text-xs font-semibold text-slate-400"
        >
          {game.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium text-slate-100">
          {/* The link covers the whole row. */}
          <Link
            href={gameHref(game.appid)}
            title={game.name}
            className="block truncate after:absolute after:inset-0 after:rounded-xl hover:text-steam-300 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-steam-400"
          >
            {game.name}
          </Link>
        </h3>
        <p className="truncate text-xs text-slate-500">
          {lastPlayedText(game)}
          {release ? ` · ${release}` : ""}
          {firstTag ? ` · ${firstTag}` : ""}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <span
          className={`text-sm font-semibold tabular-nums ${
            game.playtimeMinutes === 0 ? "text-amber-300" : "text-slate-200"
          }`}
        >
          {game.playtimeMinutes === 0 ? "0 h" : formatPlaytime(game.playtimeMinutes)}
        </span>
        <PriceTag store={store} storeState={storeState} size="xs" />
      </div>
    </li>
  );
}

// =============================================================================
// Bang-for-your-buck indicator (unplayed games)
// =============================================================================

export type ValueState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "free" }
  | { kind: "priced"; price: AppPrice };

/** Exported so it can be rendered on its own in tests and previews. */
export function ValueIndicator({ hours, state }: { hours: number; state: ValueState }) {
  const lengthNote = (
    <p className="mt-1 text-xs text-slate-500">
      ~{hours}h length <span className="text-slate-600">(simulated)</span>
    </p>
  );

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading price">
        <div className="h-4 w-24 animate-pulse rounded bg-slate-800" />
        <div className="mt-2 h-1.5 w-full animate-pulse rounded-full bg-slate-800" />
        <div className="mt-2 h-3 w-32 animate-pulse rounded bg-slate-800" />
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div>
        <p className="text-sm font-medium text-slate-400">Price unavailable</p>
        <ValueMeter level={0} bar="bg-slate-700" />
        {lengthNote}
      </div>
    );
  }

  if (state.kind === "free") {
    return (
      <div>
        <p className="text-sm font-semibold text-steam-300">Free to play</p>
        <ValueMeter level={4} bar="bg-steam-400" />
        {lengthNote}
      </div>
    );
  }

  const { price } = state;
  const perHour = costPerHour(price.final, hours);
  const rating = rateValue(perHour);
  const tone = VALUE_TONE[rating.level];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className={`text-sm font-semibold ${tone.text}`}>{rating.label}</p>
        <p className="text-sm tabular-nums text-slate-300">
          {formatMoney(perHour, price.currency)}
          <span className="text-slate-500">/hr</span>
        </p>
      </div>
      <ValueMeter level={rating.level} bar={tone.bar} />
      <p className="mt-2 text-xs text-slate-400">
        Store price{" "}
        <span className="font-medium tabular-nums text-slate-200">
          {price.finalFormatted ?? formatMoney(price.final, price.currency)}
        </span>
        {price.discountPercent > 0 ? (
          <span className="ml-1.5 rounded bg-steam-400/15 px-1 py-0.5 text-[11px] font-semibold text-steam-300">
            -{price.discountPercent}%
          </span>
        ) : null}
      </p>
      {lengthNote}
    </div>
  );
}

