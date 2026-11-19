"use client";

/**
 * components/dashboard-view.tsx
 *
 * The signed-in dashboard: Library Health banner, the library list, and a
 * Data Age ticker. Receives the verified user from the Server Component
 * (app/(app)/dashboard/page.tsx) and loads everything else through our own
 * API with TanStack Query (v5).
 *
 *   GET /api/players/[steamid]/games   library and playtime
 *   GET /api/library/store             art, release date, price and tags for
 *                                      every owned game (v1.10), after the
 *                                      library; the list works without it
 *
 * The three stat cards choose a section (All games, Lifetime hours, Unplayed
 * backlog). One toolbar applies to all three (v1.10): filter by title or tag,
 * play status, tag, sort order, and Detailed / Compact cards. View and sort
 * are remembered in this browser; the filters last until the page is left.
 * Every game's title opens its SteamGauge page (/game/[appid]).
 *
 * Mobile-first: laid out for a 360px portrait screen, widening at sm/lg.
 *
 * Only types are imported from server-only modules. `import type` is erased
 * at build time, so no server code reaches the browser bundle.
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState, type ChangeEvent } from "react";

import {
  CompactGameRow,
  DetailedGameCard,
  ValueIndicator,
  type StoreState,
  type ValueState,
} from "@/components/game-card";
import { DataAgeTicker, ErrorState, StatePanel, primaryButton, secondaryButton } from "@/components/ui-kit";
import { pageContainer } from "@/components/layout-width";
import { TitleFilter } from "@/components/title-filter";
import { apiGet } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import {
  DEFAULT_CONTROLS,
  DEFAULT_LIBRARY_SORT,
  LIBRARY_SORTS,
  PLAY_STATUSES,
  STORE_SORTS,
  activeFilterCount,
  applyControls,
  isLibrarySort,
  isLibraryView,
  isPlayStatus,
  sectionEntries,
  tagCounts,
  type LibraryControls,
  type LibrarySection,
  type LibrarySort,
  type LibraryStorePayload,
  type LibraryView,
} from "@/lib/library-view";
import type { CacheMeta } from "@/lib/steam/cached-fetch";
import type { OwnedGame, OwnedGames } from "@/lib/steam/endpoints";
import { simulatedHoursToBeat } from "@/lib/value";

// Re-exported for tests and previews.
export { simulatedHoursToBeat, ValueIndicator };
export type { ValueState };

// =============================================================================
// Configuration
// =============================================================================

/** Games rendered per "Show more" step, by card size. */
const PAGE_STEP: Record<LibraryView, number> = { detailed: 24, compact: 60 };

/** This browser remembers the card size and sort order (not the filters). */
const VIEW_STORAGE_KEY = "steamgauge.dashboard.view";
const SORT_STORAGE_KEY = "steamgauge.dashboard.sort";

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
export type LibraryFilter = LibrarySection;

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
  const hasGames = result?.status === "ok" && result.data.gameCount > 0;

  // Store data for the whole library (art, release date, price, tags). The
  // list shows at once; sorts and filters that need this data switch on
  // when it arrives.
  const store = useQuery({
    queryKey: ["library", "store", user.steamid],
    queryFn: ({ signal }) => apiGet<LibraryStorePayload>("/api/library/store", signal),
    enabled: hasGames,
    // The server keeps it fresh for 12 hours.
    staleTime: 30 * 60_000,
    retry: false,
  });
  const storePayload = store.data?.status === "ok" ? store.data.data : null;
  const storeState: StoreState = storePayload ? "ready" : store.isPending ? "loading" : "unavailable";

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
                <LibraryPanel
                  games={result.data.games}
                  filter={filter}
                  store={storePayload}
                  storeState={storeState}
                  onRetryStore={() => void store.refetch()}
                />
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
// Library list (section from the stat cards, controls shared by all three)
// =============================================================================

/** Heading and wording for each section. Exported for tests. */
export const SECTION_COPY: Record<LibrarySection, { eyebrow: string; title: string; noun: string; order: string }> = {
  all: { eyebrow: "Library", title: "All games", noun: "games", order: "A to Z" },
  playtime: { eyebrow: "Lifetime hours", title: "Most played", noun: "games", order: "by playtime" },
  backlog: { eyebrow: "Backlog guardian", title: "Owned, never played", noun: "unplayed games", order: "A to Z" },
};

/**
 * A choice remembered in this browser. The first render uses the default (as
 * the server did), then the stored value, so hydration always matches.
 * Storage that is blocked or full is ignored.
 */
function useStoredChoice<T extends string>(
  key: string,
  isValid: (value: unknown) => value is T,
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (isValid(stored)) setValue(stored);
    } catch {
      // Storage unavailable: keep the default.
    }
  }, [key, isValid]);
  const choose = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // Not remembered; still applied for this visit.
      }
    },
    [key],
  );
  return [value, choose];
}

function LibraryPanel({
  games,
  filter: section,
  store,
  storeState,
  onRetryStore,
}: {
  games: readonly OwnedGame[];
  filter: LibrarySection;
  store: LibraryStorePayload | null;
  storeState: StoreState;
  onRetryStore: () => void;
}) {
  const copy = SECTION_COPY[section];

  // Kept when switching between the three stat cards.
  const [text, setText] = useState("");
  const [status, setStatus] = useState(DEFAULT_CONTROLS.status);
  const [tag, setTag] = useState("");
  const [sort, setSort] = useStoredChoice<LibrarySort>(SORT_STORAGE_KEY, isLibrarySort, DEFAULT_LIBRARY_SORT);
  const [view, setView] = useStoredChoice<LibraryView>(VIEW_STORAGE_KEY, isLibraryView, "detailed");

  // Sorts by price or release date wait for store data; until then the
  // section's own order is used.
  const effectiveSort: LibrarySort = STORE_SORTS.has(sort) && !store ? "section" : sort;
  const controls: LibraryControls = { text, status, tag, sort: effectiveSort };

  const entries = useMemo(() => sectionEntries(games, section, store), [games, section, store]);
  const matching = useMemo(
    () => applyControls(entries, controls, section),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- controls is rebuilt from these each render
    [entries, text, status, tag, effectiveSort, section],
  );
  const tags = useMemo(() => tagCounts(entries), [entries]);
  const filtersOn = activeFilterCount(controls, section);

  // Any change of section, filter, sort or card size starts again from the top.
  const step = PAGE_STEP[view];
  const [limit, setLimit] = useState(step);
  const listKey = `${section}|${text.trim()}|${status}|${tag}|${effectiveSort}|${view}`;
  const [shownKey, setShownKey] = useState(listKey);
  if (shownKey !== listKey) {
    setShownKey(listKey);
    setLimit(step);
  }
  const shown = matching.slice(0, limit);
  const total = matching.length;

  const clearFilters = () => {
    setText("");
    setStatus("any");
    setTag("");
  };
  const showRank = section === "playtime";
  const isBacklog = section === "backlog";
  const orderLabel =
    effectiveSort === "section"
      ? copy.order
      : (LIBRARY_SORTS.find((option) => option.value === effectiveSort)?.label ?? "").toLowerCase();

  return (
    <section id="library-list" aria-labelledby="library-list-heading">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`text-xs font-medium uppercase tracking-wider ${
              isBacklog ? "text-amber-400" : "text-steam-400"
            }`}
          >
            {copy.eyebrow}
          </p>
          <h2 id="library-list-heading" className="mt-1 text-lg font-semibold text-slate-50">
            {copy.title}
            <span className="ml-2 text-sm font-normal text-slate-400">{orderLabel}</span>
          </h2>
        </div>
        <p aria-live="polite" className="shrink-0 text-right text-xs text-slate-500">
          <span className="font-semibold tabular-nums text-slate-300">{wholeNumber.format(total)}</span>{" "}
          {filtersOn > 0 ? `of ${wholeNumber.format(entries.length)} ` : ""}
          {(filtersOn > 0 ? entries.length : total) === 1 ? copy.noun.replace(/s$/, "") : copy.noun}
          {filtersOn > 0 ? " match" : ""}
          {total > shown.length ? <span className="block">Showing {wholeNumber.format(shown.length)}</span> : null}
        </p>
      </div>

      <LibraryToolbar
        section={section}
        text={text}
        onText={setText}
        status={status}
        onStatus={setStatus}
        tag={tag}
        onTag={setTag}
        tags={tags}
        sort={sort}
        onSort={setSort}
        view={view}
        onView={setView}
        storeState={storeState}
        filtersOn={filtersOn}
        onClear={clearFilters}
      />

      {storeState === "unavailable" ? (
        <p role="status" className="mt-3 text-xs text-slate-400">
          Store details (art, prices, release dates, tags) could not be loaded, so those sorts and
          the tag filter are off.{" "}
          <button
            type="button"
            onClick={onRetryStore}
            className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
          >
            Try again
          </button>
        </p>
      ) : store && store.covered < store.total ? (
        <p className="mt-3 text-xs text-slate-500">
          Store details cover your {wholeNumber.format(store.covered)} most-played games of{" "}
          {wholeNumber.format(store.total)}.
        </p>
      ) : null}

      {total === 0 && filtersOn > 0 ? (
        <div className="mt-4 rounded-2xl border border-slate-800 bg-surface p-6 text-center">
          <p className="text-base font-medium text-slate-200">No games here match these filters</p>
          <p className="mt-1 text-sm text-slate-400">
            Filters apply only to your library.{" "}
            <button
              type="button"
              onClick={clearFilters}
              className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
            >
              Clear the filters
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
          {view === "detailed" ? (
            <ul
              aria-label={copy.title}
              className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5"
            >
              {shown.map(({ game, rank, store: item }) => (
                <DetailedGameCard
                  key={game.appid}
                  game={game}
                  rank={rank}
                  showRank={showRank}
                  store={item}
                  storeState={storeState}
                />
              ))}
            </ul>
          ) : (
            <ul
              aria-label={copy.title}
              className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4"
            >
              {shown.map(({ game, rank, store: item }) => (
                <CompactGameRow
                  key={game.appid}
                  game={game}
                  rank={rank}
                  showRank={showRank}
                  store={item}
                  storeState={storeState}
                />
              ))}
            </ul>
          )}

          {total > shown.length ? (
            <div className="mt-4 flex justify-center">
              <button type="button" onClick={() => setLimit((current) => current + step)} className={secondaryButton}>
                Show {wholeNumber.format(Math.min(step, total - shown.length))} more
                <span className="sr-only"> of {copy.title}</span>
              </button>
            </div>
          ) : null}

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            Prices are current US store prices, not what you paid.
            {view === "detailed" && shown.some(({ game }) => game.playtimeMinutes === 0)
              ? " Game length in the value meter is a simulated placeholder, not real completion data."
              : ""}
          </p>
        </>
      )}
    </section>
  );
}

const selectClass =
  "min-h-10 w-full min-w-0 rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm text-slate-100 focus-visible:border-steam-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400/40 disabled:cursor-not-allowed disabled:opacity-60";

/** The controls shared by all three sections. */
function LibraryToolbar({
  section,
  text,
  onText,
  status,
  onStatus,
  tag,
  onTag,
  tags,
  sort,
  onSort,
  view,
  onView,
  storeState,
  filtersOn,
  onClear,
}: {
  section: LibrarySection;
  text: string;
  onText: (text: string) => void;
  status: LibraryControls["status"];
  onStatus: (status: LibraryControls["status"]) => void;
  tag: string;
  onTag: (tag: string) => void;
  tags: readonly { name: string; count: number }[];
  sort: LibrarySort;
  onSort: (sort: LibrarySort) => void;
  view: LibraryView;
  onView: (view: LibraryView) => void;
  storeState: StoreState;
  filtersOn: number;
  onClear: () => void;
}) {
  const id = useId();
  const isBacklog = section === "backlog";
  const storeReady = storeState === "ready";
  // A chosen tag stays listed even if it is not in this section.
  const tagOptions = tag && !tags.some((option) => option.name === tag) ? [{ name: tag, count: 0 }, ...tags] : tags;

  return (
    <div className="mt-4 rounded-2xl border border-slate-800 bg-chrome p-3 sm:p-4">
      {/* Phones: search on its own row, then two controls per row. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-3 lg:grid-cols-[minmax(16rem,2fr)_repeat(3,minmax(0,1fr))_auto] lg:items-end">
        <TitleFilter
          value={text}
          onChange={onText}
          label="Filter your games by title or tag"
          placeholder="Filter by title or tag"
          className="col-span-2 w-full lg:col-span-1"
        />

        <div className="min-w-0">
          <label htmlFor={`${id}-status`} className="mb-1 block text-xs font-medium text-slate-400">
            Play status
          </label>
          <select
            id={`${id}-status`}
            value={isBacklog ? "unplayed" : status}
            disabled={isBacklog}
            title={isBacklog ? "The backlog shows unplayed games only" : undefined}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              if (isPlayStatus(event.target.value)) onStatus(event.target.value);
            }}
            className={selectClass}
          >
            {PLAY_STATUSES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor={`${id}-tag`} className="mb-1 block text-xs font-medium text-slate-400">
            Genre or tag
          </label>
          <select
            id={`${id}-tag`}
            value={tag}
            disabled={!storeReady || tagOptions.length === 0}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => onTag(event.target.value)}
            className={selectClass}
          >
            <option value="">
              {storeState === "loading" ? "Loading tags…" : storeReady ? "Any tag" : "Tags unavailable"}
            </option>
            {tagOptions.map((option) => (
              <option key={option.name} value={option.name}>
                {option.name}
                {option.count > 0 ? ` (${wholeNumber.format(option.count)})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <label htmlFor={`${id}-sort`} className="mb-1 block text-xs font-medium text-slate-400">
            Sort by
          </label>
          <select
            id={`${id}-sort`}
            value={sort}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              if (isLibrarySort(event.target.value)) onSort(event.target.value);
            }}
            className={selectClass}
          >
            {LIBRARY_SORTS.map((option) => (
              <option key={option.value} value={option.value} disabled={STORE_SORTS.has(option.value) && !storeReady}>
                {option.label}
                {STORE_SORTS.has(option.value) && storeState === "loading" ? " (loading…)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="min-w-0">
          <span id={`${id}-view`} className="mb-1 block text-xs font-medium text-slate-400">
            Card size
          </span>
          <div
            role="group"
            aria-labelledby={`${id}-view`}
            className="inline-flex w-full rounded-xl border border-slate-700 bg-slate-900 p-0.5 lg:w-auto"
          >
            {(
              [
                ["detailed", "Detailed", <GridIcon key="g" />],
                ["compact", "Compact", <ListIcon key="l" />],
              ] as const
            ).map(([value, label, icon]) => (
              <button
                key={value}
                type="button"
                aria-pressed={view === value}
                title={`${label} cards`}
                onClick={() => onView(value)}
                className={`inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-medium sm:px-3 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 lg:flex-none ${
                  view === value ? "bg-steam-400 text-slate-950" : "text-slate-300 hover:bg-slate-800 hover:text-slate-100"
                }`}
              >
                {icon}
                {/* Icon-only on phones, where the column is narrow; still named for screen readers. */}
                <span className="sr-only sm:not-sr-only">{label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {filtersOn > 0 ? (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClear}
            className="text-xs font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
          >
            Clear {filtersOn === 1 ? "filter" : `${filtersOn} filters`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function GridIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
      <rect x="1.5" y="2" width="13" height="2.5" rx="1" />
      <rect x="1.5" y="6.75" width="13" height="2.5" rx="1" />
      <rect x="1.5" y="11.5" width="13" height="2.5" rx="1" />
    </svg>
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

