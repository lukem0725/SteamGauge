/**
 * components/player-metrics.tsx
 *
 * Player figures on the game page (v1.12). Every number shown here is a
 * reported figure, never an estimate:
 *
 *   LivePlayersBadge   "Current In-Game Players", next to the review badge.
 *                      Steam's live count (ISteamUserStats/
 *                      GetNumberOfCurrentPlayers, cached 10 minutes).
 *   PlayerPeaksPanel   "24-Hour Peak Players" and "All-Time Peak Players",
 *                      under "About this game". IsThereAnyDeal's player
 *                      stats (games/info, tracked from Steam, cached 1 hour).
 *                      Counts only: ITAD reports no date for a peak, so
 *                      none is shown (v1.12.2).
 *
 * Both read the game details request the page already makes (insights,
 * full mode), so they add no requests. A missing figure shows "N/A" in the
 * same space, so the layout never shifts.
 *
 * Replaces the player history chart (v1.11–v1.11.2), which drew modelled
 * estimates where no recordings existed.
 */
import type { GameInsights } from "@/lib/game-insights";

const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** "1,248,592", or "N/A" for anything that is not a whole number of players. */
export function formatPlayerCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? wholeNumber.format(value) : "N/A";
}

/** Steam's "in-game" status green, used only for the live dot. */
const IN_GAME_GREEN = "#90BA3C";

export type FigureState = "loading" | "ready" | "unavailable";

export function LivePlayersBadge({
  players,
  state,
  now = Date.now(),
}: {
  players: GameInsights["players"];
  state: FigureState;
  now?: number;
}) {
  if (state === "loading") {
    return <span aria-busy="true" aria-label="Loading current players" className="inline-block h-7 w-56 animate-pulse rounded-md bg-slate-800" />;
  }
  const count = state === "ready" ? (players?.count ?? null) : null;
  const minutes = players ? Math.max(0, Math.round((now - Date.parse(players.asOf)) / 60_000)) : null;
  const age = minutes === null || !Number.isFinite(minutes) ? null : minutes === 0 ? "just now" : `${minutes} min ago`;
  return (
    <span
      className="inline-flex items-center gap-2 rounded-md border border-slate-700 bg-chrome px-2.5 py-1 text-sm"
      title={count !== null && age ? `Live count from Steam, ${age}` : "Steam has no live count for this game right now"}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: count !== null ? IN_GAME_GREEN : "#475569" }}
      />
      <span className="font-semibold tabular-nums text-white">{formatPlayerCount(count)}</span>
      <span className="text-slate-300">Current In-Game Players</span>
    </span>
  );
}

export function PlayerPeaksPanel({ peaks, state }: { peaks: GameInsights["playerPeaks"]; state: FigureState }) {
  const note = (value: number | null | undefined, source: string) =>
    state === "unavailable"
      ? "Couldn't be loaded just now"
      : !peaks
        ? "Not available"
        : typeof value === "number"
          ? source
          : "Not tracked for this game";
  return (
    <section aria-labelledby="player-peaks-heading" className="mt-6">
      <h3 id="player-peaks-heading" className="text-xs font-medium uppercase tracking-wider text-slate-500">
        Player peaks
      </h3>
      <dl className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <PeakCard
          label="24-Hour Peak Players"
          value={peaks?.day}
          note={note(peaks?.day, "IsThereAnyDeal · daily snapshot")}
          loading={state === "loading"}
        />
        <PeakCard
          label="All-Time Peak Players"
          value={peaks?.allTime}
          note={note(peaks?.allTime, "IsThereAnyDeal · historical peak")}
          loading={state === "loading"}
        />
      </dl>
      <p className="mt-2 text-xs text-slate-500">
        Peaks tracked from Steam by{" "}
        <a
          href="https://isthereanydeal.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="text-steam-300 underline underline-offset-2 hover:text-steam-200"
        >
          IsThereAnyDeal
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>
    </section>
  );
}

function PeakCard({
  label,
  value,
  note,
  loading,
}: {
  label: string;
  value: number | null | undefined;
  note: string;
  loading: boolean;
}) {
  return (
    <div className="flex min-h-[6.5rem] min-w-0 flex-col rounded-2xl border border-slate-800 bg-chrome p-4">
      <dt className="order-2 mt-1 text-sm text-slate-300">{label}</dt>
      <dd className="order-1">
        {loading ? (
          <span aria-busy="true" aria-label={`Loading ${label}`} className="block h-8 w-32 animate-pulse rounded bg-slate-800" />
        ) : (
          <span className={`text-2xl font-semibold tabular-nums sm:text-3xl ${typeof value === "number" ? "text-white" : "text-slate-500"}`}>
            {formatPlayerCount(value)}
          </span>
        )}
      </dd>
      <dd className="order-3 mt-0.5 text-xs text-slate-500">{loading ? " " : note}</dd>
    </div>
  );
}
