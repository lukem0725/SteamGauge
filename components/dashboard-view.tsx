"use client";

/**
 * components/dashboard-view.tsx
 *
 * The signed-in dashboard: Library Health banner, Backlog Guardian deck, and
 * a Data Age ticker. Receives the verified user from the Server Component
 * (app/(app)/dashboard/page.tsx) and loads everything else through our own
 * API with TanStack Query (v5).
 *
 *   GET /api/players/[steamid]/games   library and playtime  (one request)
 *   GET /api/apps/[appid]              store price, per backlog card, only
 *                                      once that card scrolls into view
 *
 * Mobile-first: laid out for a 360px portrait screen, widening at sm/lg.
 *
 * Only types are imported from server-only modules. `import type` is erased
 * at build time, so no server code reaches the browser bundle.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  DataAgeTicker,
  ErrorState,
  StatePanel,
  VALUE_TONE,
  ValueMeter,
  formatMoney,
  primaryButton,
  secondaryButton,
  useInViewOnce,
} from "@/components/ui-kit";
import { pageContainer } from "@/components/layout-width";
import { TitleFilter } from "@/components/title-filter";
import { apiGet } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import type { CacheMeta } from "@/lib/steam/cached-fetch";
import type { AppDetails, OwnedGame, OwnedGames } from "@/lib/steam/endpoints";
import { matchesTitle } from "@/lib/title-search";
import { costPerHour, rateValue, simulatedHoursToBeat } from "@/lib/value";

// Re-exported for tests and previews.
export { simulatedHoursToBeat };

// =============================================================================
// Configuration
// =============================================================================

/** Games rendered per "Show more" step. Backlog cards each make one lazy price lookup. */
const PAGE_STEP = 24;

/** After a stale answer, re-check this many times for the refreshed data. */
const STALE_RECHECK_LIMIT = 2;
const STALE_RECHECK_MS = 4_000;

const STEAM_PRIVACY_SETTINGS_URL = "https://steamcommunity.com/my/edit/settings";

// =============================================================================
// Entry point
// =============================================================================

export interface DashboardViewProps {
  /** The verified session user, from the Server Component. */
  readonly user: SessionUser;
}

export function DashboardView({ user }: DashboardViewProps) {
  return <Dashboard user={user} />;
}

/**
 * Which slice of the library the list shows. Chosen by clicking one of the
 * three stat cards in the Library Health banner.
 *
 *   all       every owned game, A to Z
 *   playtime  every owned game, most played first
 *   backlog   games with exactly 0 minutes played, A to Z (the default)
 */
export type LibraryFilter = "all" | "playtime" | "backlog";

function Dashboard({ user }: DashboardViewProps) {
  const [filter, setFilter] = useState<LibraryFilter>("backlog");

  const library = useQuery({
    queryKey: ["player", user.steamid, "games"],
    queryFn: ({ signal }) =>
      apiGet<OwnedGames>(`/api/players/${encodeURIComponent(user.steamid)}/games`, signal),
    // The server cache keeps a library fresh for an hour; five minutes here
    // just avoids refetching while moving between pages.
    staleTime: 5 * 60_000,
    // A stale answer means the server started a background refresh. Look
    // again a couple of times to pick up the new data, then stop. This is a
    // bounded follow-up, not polling.
    refetchInterval: (query) =>
      query.state.data?.meta.stale && query.state.dataUpdateCount <= STALE_RECHECK_LIMIT
        ? STALE_RECHECK_MS
        : false,
  });

  const result = library.data;

  return (
    <div className="bg-page text-slate-100 antialiased">
      <div className={pageContainer}>
        <Header user={user} meta={result?.meta ?? null} isFetching={library.isFetching} />

        <main className="mt-6 space-y-8">
          {library.isPending ? (
            <DashboardSkeleton />
          ) : library.isError ? (
            <ErrorState
              error={library.error}
              onRetry={() => void library.refetch()}
              retrying={library.isFetching}
            />
          ) : result?.status === "ok" ? (
            result.data.gameCount === 0 ? (
              <EmptyLibraryState />
            ) : (
              <>
                <LibraryHealthBanner
                  library={result.data}
                  selected={filter}
                  onSelect={setFilter}
                />
                <LibraryPanel games={result.data.games} filter={filter} />
              </>
            )
          ) : (
            <PrivateLibraryState onRetry={() => void library.refetch()} retrying={library.isFetching} />
          )}
        </main>
      </div>
    </div>
  );
}

// =============================================================================
// Header and Data Age ticker
// =============================================================================

function Header({
  user,
  meta,
  isFetching,
}: {
  user: SessionUser;
  meta: CacheMeta | null;
  isFetching: boolean;
}) {
  const name = user.personaName ?? "Player";
  return (
    <header className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        {user.avatarUrl ? (
          // Steam CDN image; a plain <img> avoids next/image remote configuration.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={user.avatarUrl}
            alt=""
            width={44}
            height={44}
            className="h-11 w-11 shrink-0 rounded-full ring-1 ring-slate-700"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-800 text-sm font-semibold text-slate-300 ring-1 ring-slate-700"
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-slate-500">Dashboard</p>
          <h1 className="truncate text-lg font-semibold leading-tight text-slate-50">{name}</h1>
        </div>
      </div>
      <DataAgeTicker meta={meta} isFetching={isFetching} />
    </header>
  );
}

// =============================================================================
// Library Health banner
// =============================================================================

const wholeNumber = new Intl.NumberFormat("en-US");

function LibraryHealthBanner({
  library,
  selected,
  onSelect,
}: {
  library: OwnedGames;
  selected: LibraryFilter;
  onSelect: (filter: LibraryFilter) => void;
}) {
  const backlog = library.games.filter(isUnplayed).length;
  const played = library.gameCount - backlog;
  const playedPercent = library.gameCount > 0 ? Math.round((played / library.gameCount) * 100) : 0;
  const hours = Math.round(library.totalPlaytimeMinutes / 60);

  return (
    <section
      aria-labelledby="library-health-heading"
      className="relative overflow-hidden rounded-3xl border border-slate-800 bg-surface p-5 sm:p-7"
    >
      {/* Soft glow. Decorative only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-steam-500/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-28 -left-20 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl"
      />

      <div className="relative">
        <p className="text-xs font-medium uppercase tracking-wider text-steam-400">
          Library health
        </p>
        <h2
          id="library-health-heading"
          className="mt-1 text-xl font-semibold tracking-tight text-slate-50 sm:text-2xl"
        >
          {backlog === 0
            ? "Every game played. Spotless."
            : `${playedPercent}% of your library has been played`}
        </h2>

        <div
          role="progressbar"
          aria-label="Share of library played"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={playedPercent}
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-steam-400 transition-[width] duration-700"
            style={{ width: `${playedPercent}%` }}
          />
        </div>

        {/* The three cards are toggle buttons that choose what the list below shows. */}
        <div
          role="group"
          aria-label="Choose which games to list"
          className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3"
        >
          <StatButton
            filter="all"
            selected={selected}
            onSelect={onSelect}
            label="Games owned"
            value={wholeNumber.format(library.gameCount)}
            hint="All games, A to Z"
          />
          <StatButton
            filter="playtime"
            selected={selected}
            onSelect={onSelect}
            label="Lifetime hours"
            value={wholeNumber.format(hours)}
            hint="Most played first"
          />
          <StatButton
            filter="backlog"
            selected={selected}
            onSelect={onSelect}
            label="Unplayed backlog"
            value={wholeNumber.format(backlog)}
            unit={`${backlog === 1 ? "game" : "games"} at 0 hours`}
            hint="Never played, A to Z"
            accent
            className="col-span-2 sm:col-span-1"
          />
        </div>
      </div>
    </section>
  );
}

/**
 * One stat card, working as a toggle button. Its pressed state is exposed
 * with aria-pressed and shown with a ring and a "Showing" marker, never by
 * colour alone.
 */
function StatButton({
  filter,
  selected,
  onSelect,
  label,
  value,
  unit,
  hint,
  accent = false,
  className = "",
}: {
  filter: LibraryFilter;
  selected: LibraryFilter;
  onSelect: (filter: LibraryFilter) => void;
  label: string;
  value: string;
  unit?: string;
  hint: string;
  accent?: boolean;
  className?: string;
}) {
  const active = filter === selected;
  const tone = accent
    ? active
      ? "border-amber-300 bg-amber-400/15 ring-2 ring-amber-300/60"
      : "border-amber-400/30 bg-amber-400/10 hover:border-amber-300/60 hover:bg-amber-400/15"
    : active
      ? "border-steam-400 bg-slate-800/80 ring-2 ring-steam-400/50"
      : "border-slate-800 bg-slate-900/60 hover:border-slate-600 hover:bg-slate-800/60";

  return (
    <button
      type="button"
      aria-pressed={active}
      aria-controls="library-list"
      onClick={() => onSelect(filter)}
      className={`group relative rounded-2xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-300 ${tone} ${className}`}
    >
      <span
        className={`flex items-center justify-between gap-2 text-xs font-medium uppercase tracking-wider ${
          accent ? "text-amber-300" : "text-slate-500"
        }`}
      >
        {label}
        {active ? (
          <span
            className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${
              accent ? "bg-amber-300 text-slate-950" : "bg-steam-400 text-slate-950"
            }`}
          >
            Showing
          </span>
        ) : null}
      </span>
      <span className="mt-1 flex items-baseline gap-2">
        <span
          className={`tabular-nums tracking-tight ${
            accent ? "text-4xl font-bold text-amber-200" : "text-3xl font-semibold text-slate-50"
          }`}
        >
          {value}
        </span>
        {unit ? <span className="text-sm text-amber-200/70">{unit}</span> : null}
      </span>
      <span
        className={`mt-2 block text-xs ${
          active ? "text-slate-300" : "text-slate-500 group-hover:text-slate-400"
        }`}
      >
        {hint}
      </span>
    </button>
  );
}

/** Backlog rule: exactly zero minutes of recorded playtime. */
function isUnplayed(game: OwnedGame): boolean {
  return game.playtimeMinutes === 0;
}

// =============================================================================
// Library list (driven by the stat cards)
// =============================================================================

const byName = (a: OwnedGame, b: OwnedGame) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" });

/** The games, title and wording for each filter. Exported for tests. */
export function selectLibrary(games: readonly OwnedGame[], filter: LibraryFilter) {
  switch (filter) {
    case "all":
      return {
        games: [...games].sort(byName),
        eyebrow: "Library",
        title: "All games, A to Z",
        noun: "games",
      };
    case "playtime":
      return {
        games: [...games].sort((a, b) => b.playtimeMinutes - a.playtimeMinutes || byName(a, b)),
        eyebrow: "Library",
        title: "Most played",
        noun: "games",
      };
    case "backlog":
      return {
        games: games.filter(isUnplayed).sort(byName),
        eyebrow: "Backlog guardian",
        title: "Owned, never played",
        noun: "unplayed games",
      };
  }
}

function LibraryPanel({ games, filter }: { games: readonly OwnedGame[]; filter: LibraryFilter }) {
  const view = selectLibrary(games, filter);
  const [limit, setLimit] = useState(PAGE_STEP);
  // Kept when switching between the three stat cards.
  const [query, setQuery] = useState("");
  const trimmed = query.trim();

  // A new list or a new filter starts again from the top.
  const [shownKey, setShownKey] = useState(`${filter}|${trimmed}`);
  if (shownKey !== `${filter}|${trimmed}`) {
    setShownKey(`${filter}|${trimmed}`);
    setLimit(PAGE_STEP);
  }

  // Playtime rank is the game's place in the whole list, kept when filtering.
  const ranked = view.games.map((game, index) => ({ game, rank: index + 1 }));
  const matching = trimmed ? ranked.filter(({ game }) => matchesTitle(trimmed, game.name)) : ranked;
  const shown = matching.slice(0, limit);
  const total = matching.length;
  const isBacklog = filter === "backlog";

  return (
    <section id="library-list" aria-labelledby="library-list-heading">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`text-xs font-medium uppercase tracking-wider ${
              isBacklog ? "text-amber-400" : "text-steam-400"
            }`}
          >
            {view.eyebrow}
          </p>
          <h2 id="library-list-heading" className="mt-1 text-lg font-semibold text-slate-50">
            {view.title}
          </h2>
        </div>
        <p aria-live="polite" className="shrink-0 text-right text-xs text-slate-500">
          <span className="font-semibold tabular-nums text-slate-300">
            {wholeNumber.format(total)}
          </span>{" "}
          {trimmed ? `of ${wholeNumber.format(view.games.length)} ` : ""}
          {(trimmed ? view.games.length : total) === 1 ? view.noun.replace(/s$/, "") : view.noun}
          {trimmed ? " match" : ""}
          {total > shown.length ? (
            <span className="block">Showing {wholeNumber.format(shown.length)}</span>
          ) : null}
        </p>
      </div>

      <TitleFilter
        value={query}
        onChange={setQuery}
        label={`Filter ${view.title.toLowerCase()} by title`}
        placeholder="Filter your games by title"
        className="mt-4 w-full sm:max-w-sm"
      />

      {total === 0 && trimmed ? (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-surface p-6 text-center">
          <p className="text-base font-medium text-slate-200">No games here match &ldquo;{trimmed}&rdquo;</p>
          <p className="mt-1 text-sm text-slate-400">
            This filters only your library.{" "}
            <button
              type="button"
              onClick={() => setQuery("")}
              className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
            >
              Clear the filter
            </button>
          </p>
        </div>
      ) : total === 0 ? (
        <div className="mt-4 rounded-2xl border border-steam-400/20 bg-steam-400/5 p-6 text-center">
          <p className="text-base font-medium text-steam-200">Backlog cleared</p>
          <p className="mt-1 text-sm text-slate-400">
            Every game you own has some playtime. Nothing is gathering dust.
          </p>
        </div>
      ) : (
        <>
          {isBacklog ? (
            <ul
              aria-label={view.title}
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            >
              {shown.map(({ game }) => (
                <BacklogCard key={game.appid} game={game} />
              ))}
            </ul>
          ) : (
            <ol
              aria-label={view.title}
              className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              {shown.map(({ game, rank }) => (
                <GameRow key={game.appid} game={game} rank={filter === "playtime" ? rank : null} />
              ))}
            </ol>
          )}

          {total > shown.length ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setLimit((current) => current + PAGE_STEP)}
                className={secondaryButton}
              >
                Show {Math.min(PAGE_STEP, total - shown.length)} more
                <span className="sr-only"> of {view.title}</span>
              </button>
            </div>
          ) : null}

          {isBacklog ? (
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              Price is the current US store price, not what you paid. Length is a simulated
              placeholder, not real completion data.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

const hoursFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

function formatPlaytime(minutes: number): string {
  if (minutes === 0) return "Never played";
  if (minutes < 60) return `${minutes} min`;
  return `${hoursFormat.format(minutes / 60)} h`;
}

/** A compact row for the "all" and "playtime" lists. No network requests. */
function GameRow({ game, rank }: { game: OwnedGame; rank: number | null }) {
  return (
    <li className="relative flex min-h-14 items-center gap-3 rounded-xl border border-slate-800 bg-surface-raised px-3 py-2">
      {rank !== null ? (
        <span className="w-7 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-500">
          {rank}
        </span>
      ) : null}
      {game.iconUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={game.iconUrl}
          alt=""
          width={32}
          height={32}
          loading="lazy"
          className="h-8 w-8 shrink-0 rounded"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-slate-800 text-xs font-semibold text-slate-400"
        >
          {game.name.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <a
          href={`https://store.steampowered.com/app/${game.appid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="block truncate text-sm font-medium text-slate-100 after:absolute after:inset-0 after:rounded-xl hover:text-white focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-steam-400"
          title={game.name}
        >
          {game.name}
          <span className="sr-only"> (opens Steam in a new tab)</span>
        </a>
        <p className="text-xs text-slate-500">
          {game.lastPlayedAt
            ? `Last played ${new Date(game.lastPlayedAt).toLocaleDateString("en-US", {
                month: "short",
                year: "numeric",
              })}`
            : "No play date recorded"}
        </p>
      </div>
      <span
        className={`shrink-0 text-sm font-semibold tabular-nums ${
          game.playtimeMinutes === 0 ? "text-amber-300" : "text-slate-200"
        }`}
      >
        {formatPlaytime(game.playtimeMinutes)}
      </span>
    </li>
  );
}

function BacklogCard({ game }: { game: OwnedGame }) {
  const [ref, inView] = useInViewOnce<HTMLLIElement>();

  // One store lookup per card, and only once the card is actually on screen.
  // The server shares each answer between all users for 24 hours.
  const details = useQuery({
    queryKey: ["app", game.appid, "details"],
    queryFn: ({ signal }) => apiGet<AppDetails>(`/api/apps/${game.appid}`, signal),
    enabled: inView,
    staleTime: 60 * 60_000,
    // If the store budget is spent, show "unavailable" instead of piling on.
    retry: false,
  });

  const app = details.data?.status === "ok" ? details.data.data : null;
  const hours = simulatedHoursToBeat(game.appid);

  return (
    <li
      ref={ref}
      // `relative` keeps the visually hidden link text inside the card, so
      // it can never widen the page on phones.
      className="relative flex flex-col overflow-hidden rounded-2xl border border-slate-800 bg-surface-raised"
    >
      <div className="relative aspect-[460/215] w-full bg-slate-900">
        {app?.headerImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={app.headerImage}
            alt=""
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#1e2836,#121822)]">
            {game.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={game.iconUrl}
                alt=""
                width={32}
                height={32}
                loading="lazy"
                className="h-8 w-8 rounded"
              />
            ) : (
              <span aria-hidden="true" className="text-2xl font-semibold text-slate-600">
                {game.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-full bg-slate-950/80 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/30">
          0h played
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="truncate text-sm font-semibold text-slate-100" title={game.name}>
          {game.name}
        </h3>

        <div className="mt-3 flex-1">
          <ValueIndicator
            hours={hours}
            state={
              !inView || details.isPending
                ? { kind: "loading" }
                : app
                  ? app.isFree || !app.price
                    ? app.isFree
                      ? { kind: "free" }
                      : { kind: "unavailable" }
                    : { kind: "priced", price: app.price }
                  : { kind: "unavailable" }
            }
          />
        </div>

        <a
          href={`https://store.steampowered.com/app/${game.appid}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
        >
          View on Steam
          <span className="sr-only"> (opens in a new tab): {game.name}</span>
        </a>
      </div>
    </li>
  );
}

// -----------------------------------------------------------------------------
// Bang-for-your-buck indicator
// -----------------------------------------------------------------------------

export type ValueState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "free" }
  | { kind: "priced"; price: NonNullable<AppDetails["price"]> };

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

// =============================================================================
// Loading, empty, private and error states
// =============================================================================

function DashboardSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading your library" className="space-y-8">
      <div className="rounded-3xl border border-slate-800 bg-surface p-5 sm:p-7">
        <div className="h-3 w-24 animate-pulse rounded bg-slate-800" />
        <div className="mt-3 h-6 w-3/4 animate-pulse rounded bg-slate-800" />
        <div className="mt-4 h-2 w-full animate-pulse rounded-full bg-slate-800" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="h-24 animate-pulse rounded-2xl bg-slate-900" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-900" />
          <div className="col-span-2 h-24 animate-pulse rounded-2xl bg-slate-900 sm:col-span-1" />
        </div>
      </div>
      <div>
        <div className="h-5 w-48 animate-pulse rounded bg-slate-800" />
        <div className="-mx-4 mt-4 flex gap-3 overflow-hidden px-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 w-[17rem] shrink-0 animate-pulse rounded-2xl bg-slate-900" />
          ))}
        </div>
      </div>
    </div>
  );
}

function PrivateLibraryState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <StatePanel
      tone="amber"
      title="Your game details are private"
      actions={
        <>
          <a
            href={STEAM_PRIVACY_SETTINGS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryButton}
          >
            Open Steam privacy settings
          </a>
          <button type="button" onClick={onRetry} disabled={retrying} className={secondaryButton}>
            {retrying ? "Checking…" : "Check again"}
          </button>
        </>
      }
    >
      <p>
        Steam is not sharing your library with us. In your Steam privacy settings, set{" "}
        <strong className="font-medium text-slate-200">Game details</strong> to{" "}
        <strong className="font-medium text-slate-200">Public</strong>.
      </p>
      <p className="mt-2">
        We remember a private answer for up to 30 minutes, so the change can take that long to
        show here.
      </p>
    </StatePanel>
  );
}

function EmptyLibraryState() {
  return (
    <StatePanel tone="neutral" title="No games here yet">
      <p>
        Steam reports an empty library for this account. Once you own a game it will show up
        here, along with your playtime and backlog.
      </p>
    </StatePanel>
  );
}

