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
import { apiGet } from "@/lib/api/client";
import type { SessionUser } from "@/lib/auth/session";
import type { CacheMeta } from "@/lib/steam/cached-fetch";
import type { AppDetails, OwnedGame, OwnedGames } from "@/lib/steam/endpoints";
import { costPerHour, rateValue, simulatedHoursToBeat } from "@/lib/value";

// Re-exported for tests and previews.
export { simulatedHoursToBeat };

// =============================================================================
// Configuration
// =============================================================================

/** At most this many backlog cards are rendered, and so at most this many price lookups. */
const BACKLOG_DECK_LIMIT = 24;

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

function Dashboard({ user }: DashboardViewProps) {
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
    <div className="bg-zinc-950 text-zinc-100 antialiased">
      <div className="mx-auto w-full max-w-5xl px-4 pb-12 pt-5 sm:px-6 lg:px-8">
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
                <LibraryHealthBanner library={result.data} />
                <BacklogGuardianPanel games={result.data.games} />
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
            className="h-11 w-11 shrink-0 rounded-full ring-1 ring-zinc-700"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-300 ring-1 ring-zinc-700"
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-wider text-zinc-500">Dashboard</p>
          <h1 className="truncate text-lg font-semibold leading-tight text-zinc-50">{name}</h1>
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

function LibraryHealthBanner({ library }: { library: OwnedGames }) {
  const backlog = library.games.filter(isUnplayed).length;
  const played = library.gameCount - backlog;
  const playedPercent = library.gameCount > 0 ? Math.round((played / library.gameCount) * 100) : 0;
  const hours = Math.round(library.totalPlaytimeMinutes / 60);

  return (
    <section
      aria-labelledby="library-health-heading"
      className="relative overflow-hidden rounded-3xl border border-zinc-800 bg-[#131316] p-5 sm:p-7"
    >
      {/* Soft glow. Decorative only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-emerald-500/10 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-28 -left-20 h-64 w-64 rounded-full bg-amber-500/10 blur-3xl"
      />

      <div className="relative">
        <p className="text-xs font-medium uppercase tracking-wider text-emerald-400">
          Library health
        </p>
        <h2
          id="library-health-heading"
          className="mt-1 text-xl font-semibold tracking-tight text-zinc-50 sm:text-2xl"
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
          className="mt-4 h-2 w-full overflow-hidden rounded-full bg-zinc-800"
        >
          <div
            className="h-full rounded-full bg-emerald-400 transition-[width] duration-700"
            style={{ width: `${playedPercent}%` }}
          />
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <Stat label="Games owned" value={wholeNumber.format(library.gameCount)} />
          <Stat label="Lifetime hours" value={wholeNumber.format(hours)} />
          <div className="col-span-2 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 sm:col-span-1">
            <dt className="text-xs font-medium uppercase tracking-wider text-amber-300">
              Unplayed backlog
            </dt>
            <dd className="mt-1 flex items-baseline gap-2">
              <span className="text-4xl font-bold tabular-nums tracking-tight text-amber-200">
                {wholeNumber.format(backlog)}
              </span>
              <span className="text-sm text-amber-200/70">
                {backlog === 1 ? "game" : "games"} at 0 hours
              </span>
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <dt className="text-xs font-medium uppercase tracking-wider text-zinc-500">{label}</dt>
      <dd className="mt-1 text-3xl font-semibold tabular-nums tracking-tight text-zinc-50">
        {value}
      </dd>
    </div>
  );
}

/** Backlog rule: exactly zero minutes of recorded playtime. */
function isUnplayed(game: OwnedGame): boolean {
  return game.playtimeMinutes === 0;
}

// =============================================================================
// Backlog Guardian panel
// =============================================================================

function BacklogGuardianPanel({ games }: { games: readonly OwnedGame[] }) {
  const backlog = games.filter(isUnplayed).sort((a, b) => a.name.localeCompare(b.name));
  const shown = backlog.slice(0, BACKLOG_DECK_LIMIT);

  return (
    <section aria-labelledby="backlog-heading">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-amber-400">
            Backlog guardian
          </p>
          <h2 id="backlog-heading" className="mt-1 text-lg font-semibold text-zinc-50">
            Owned, never played
          </h2>
        </div>
        {backlog.length > shown.length ? (
          <p className="shrink-0 text-xs text-zinc-500">
            Showing {shown.length} of {wholeNumber.format(backlog.length)}
          </p>
        ) : null}
      </div>

      {backlog.length === 0 ? (
        <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-6 text-center">
          <p className="text-base font-medium text-emerald-200">Backlog cleared</p>
          <p className="mt-1 text-sm text-zinc-400">
            Every game you own has some playtime. Nothing is gathering dust.
          </p>
        </div>
      ) : (
        <>
          {/* Horizontal deck. Negative margin lets cards bleed to the screen edge on phones. */}
          <ul
            aria-label="Unplayed games"
            className="-mx-4 mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
          >
            {shown.map((game) => (
              <BacklogCard key={game.appid} game={game} />
            ))}
          </ul>
          <p className="text-xs leading-relaxed text-zinc-500">
            Price is the current US store price, not what you paid. Length is a simulated
            placeholder, not real completion data.
          </p>
        </>
      )}
    </section>
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
      // `relative` keeps the visually hidden link text inside the deck's scroll
      // area. Without it the page itself scrolls sideways on phones.
      className="relative flex w-[17rem] shrink-0 snap-start flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-[#18181c]"
    >
      <div className="relative aspect-[460/215] w-full bg-zinc-900">
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
          <div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,#27272a,#18181b)]">
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
              <span aria-hidden="true" className="text-2xl font-semibold text-zinc-600">
                {game.name.slice(0, 1).toUpperCase()}
              </span>
            )}
          </div>
        )}
        <span className="absolute left-2 top-2 rounded-full bg-zinc-950/80 px-2 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-400/30">
          0h played
        </span>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="truncate text-sm font-semibold text-zinc-100" title={game.name}>
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
          className="mt-4 inline-flex min-h-11 items-center justify-center rounded-xl border border-zinc-700 bg-zinc-900 px-3 text-sm font-medium text-zinc-200 transition-colors hover:border-zinc-600 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
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
    <p className="mt-1 text-xs text-zinc-500">
      ~{hours}h length <span className="text-zinc-600">(simulated)</span>
    </p>
  );

  if (state.kind === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading price">
        <div className="h-4 w-24 animate-pulse rounded bg-zinc-800" />
        <div className="mt-2 h-1.5 w-full animate-pulse rounded-full bg-zinc-800" />
        <div className="mt-2 h-3 w-32 animate-pulse rounded bg-zinc-800" />
      </div>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <div>
        <p className="text-sm font-medium text-zinc-400">Price unavailable</p>
        <ValueMeter level={0} bar="bg-zinc-700" />
        {lengthNote}
      </div>
    );
  }

  if (state.kind === "free") {
    return (
      <div>
        <p className="text-sm font-semibold text-emerald-300">Free to play</p>
        <ValueMeter level={4} bar="bg-emerald-400" />
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
        <p className="text-sm tabular-nums text-zinc-300">
          {formatMoney(perHour, price.currency)}
          <span className="text-zinc-500">/hr</span>
        </p>
      </div>
      <ValueMeter level={rating.level} bar={tone.bar} />
      <p className="mt-2 text-xs text-zinc-400">
        Store price{" "}
        <span className="font-medium tabular-nums text-zinc-200">
          {price.finalFormatted ?? formatMoney(price.final, price.currency)}
        </span>
        {price.discountPercent > 0 ? (
          <span className="ml-1.5 rounded bg-emerald-400/15 px-1 py-0.5 text-[11px] font-semibold text-emerald-300">
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
      <div className="rounded-3xl border border-zinc-800 bg-[#131316] p-5 sm:p-7">
        <div className="h-3 w-24 animate-pulse rounded bg-zinc-800" />
        <div className="mt-3 h-6 w-3/4 animate-pulse rounded bg-zinc-800" />
        <div className="mt-4 h-2 w-full animate-pulse rounded-full bg-zinc-800" />
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
          <div className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
          <div className="col-span-2 h-24 animate-pulse rounded-2xl bg-zinc-900 sm:col-span-1" />
        </div>
      </div>
      <div>
        <div className="h-5 w-48 animate-pulse rounded bg-zinc-800" />
        <div className="-mx-4 mt-4 flex gap-3 overflow-hidden px-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-72 w-[17rem] shrink-0 animate-pulse rounded-2xl bg-zinc-900" />
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
        <strong className="font-medium text-zinc-200">Game details</strong> to{" "}
        <strong className="font-medium text-zinc-200">Public</strong>.
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

