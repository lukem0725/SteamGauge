"use client";

/**
 * components/player-history.tsx
 *
 * Concurrent players on the game page (v1.11), below the price history:
 *
 *   1. Three stat cards: players right now, 24-hour peak, highest recorded.
 *   2. Range buttons: 48h 1w 1m 3m 6m 1y 3y 6y max.
 *   3. A line chart of the highest reading per bucket, with a crosshair and
 *      tooltip (mouse, touch, or arrow keys), and a table view.
 *
 * Data: GET /api/apps/[appid]/players (lib/player-counts.ts). The measured
 * line is SteamGauge's own recordings, since Steam's API reports only the
 * current count and SteamDB's archive has no API; where readings are missing
 * for a while the line breaks instead of bridging the gap. Peaks also come
 * from IsThereAnyDeal (v1.11.1).
 *
 * When too little is recorded for 48h or 1w, the chart shows the server's
 * estimate instead: a dashed line, an "Estimated" tag, "≈" in the tooltip
 * and a caption saying what it is modelled on. Estimates never reach the
 * stat cards. If the players request itself fails, the panel builds the same
 * estimate in the browser from the live count the page already loaded
 * (`fallbackCurrent`), so it never shows an error banner.
 *
 * Colour: #7DA213, SteamDB's yellow-green at the same lightness as the price
 * chart's blue (#3A9AD6). The requested #A4D037 is too bright for a data mark
 * on this dark card (OKLCH L 0.80, above the 0.48-0.67 band); #7DA213 passes
 * the lightness, chroma, contrast (3:1) and colour-blind separation checks
 * against the blue and the card.
 */
import { useQuery } from "@tanstack/react-query";
import {
  useId,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type SyntheticEvent,
} from "react";

import { apiGet } from "@/lib/api/client";
import {
  DEFAULT_PLAYER_RANGE,
  PLAYER_RANGES,
  estimatePlayerSeries,
  offeredRanges,
  playerRange,
  type EstimatePoint,
  type PlayerHistory,
  type PlayerPoint,
  type PlayerRangeId,
} from "@/lib/player-history";

export const PLAYER_SERIES_COLOR = "#7da213";
const GRID_COLOR = "#263241";

const wholeNumber = new Intl.NumberFormat("en-US");
const compactNumber = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const timeFormat = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const dayTimeFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const shortDayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const monthYearFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" });
const utcDayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// =============================================================================
// Panel
// =============================================================================

/**
 * What the panel shows when the players request fails: the live count the
 * page already has (from the game facts request), and the same labelled
 * estimate the server would send. Never invents a count when there is none.
 */
export function fallbackHistory(
  appid: number,
  rangeId: PlayerRangeId,
  current: PlayerHistory["current"],
  now = Date.now(),
): PlayerHistory {
  const range = playerRange(rangeId);
  const estimated = estimatePlayerSeries({ rangeId, current, dayPeak: null, weekPeak: null, appid }, now);
  const live = current ? { players: current.count, at: current.asOf, source: "live" as const } : null;
  return {
    appid,
    range: rangeId,
    bucketSeconds: range.bucketSeconds,
    current,
    peak24h: live,
    peakAllTime: live,
    recordingSince: null,
    recording: "unavailable",
    points: current ? [{ t: current.asOf, players: current.count }] : [],
    estimate: estimated ? { points: estimated, basis: "live", kind: "cycle" } : null,
    trendAvailable: false,
  };
}

export function PlayerHistoryPanel({
  appid,
  fallbackCurrent = null,
}: {
  appid: number;
  /** The live count from the game facts request, used if the players request fails. */
  fallbackCurrent?: PlayerHistory["current"];
}) {
  const headingId = useId();
  const [rangeId, setRangeId] = useState<PlayerRangeId>(DEFAULT_PLAYER_RANGE);
  const query = useQuery({
    queryKey: ["app", "players", appid, rangeId],
    queryFn: ({ signal }) =>
      apiGet<PlayerHistory>(`/api/apps/${appid}/players?range=${rangeId}`, signal),
    staleTime: 5 * 60_000,
    retry: false,
    // Keep the last chart on screen while another range loads (same game only).
    placeholderData: (previous) =>
      previous?.status === "ok" && previous.data.appid === appid ? previous : undefined,
  });
  const served = query.data?.status === "ok" ? query.data.data : null;
  const failed = !served && !query.isPending;
  const history = served ?? (failed ? fallbackHistory(appid, rangeId, fallbackCurrent) : null);

  return (
    <section aria-labelledby={headingId}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">Players</p>
          <h3 id={headingId} className="mt-0.5 text-base font-semibold text-slate-100">
            Concurrent players
          </h3>
        </div>
        <a
          href={`https://steamdb.info/app/${appid}/charts/`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
        >
          Full history on SteamDB
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>

      {!history ? (
        <PlayerSkeleton />
      ) : (
        <>
          <PlayerStats history={history} />
          <RangeButtons
            selected={rangeId}
            available={offeredRanges(history.recordingSince, history.current !== null, Date.now(), history.trendAvailable)}
            recordingSince={history.recordingSince}
            loading={query.isFetching && (query.isPlaceholderData || failed)}
            onSelect={setRangeId}
          />
          <PlayerHistoryChart history={history} />
          <PlayerCaption history={history} />
          {failed ? (
            <p className="mt-1 text-xs text-slate-500">
              Showing what this page already loaded.{" "}
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="font-medium text-steam-300 underline underline-offset-2 hover:text-steam-200"
              >
                Load recorded history
              </button>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

// =============================================================================
// Stat cards
// =============================================================================

function ago(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : dayFormat.format(new Date(iso));
}

function when(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  return now - date.getTime() < 20 * 3600_000 ? `at ${timeFormat.format(date)}` : `on ${dayTimeFormat.format(date)}`;
}

export interface ChartPoint extends PlayerPoint {
  readonly estimated: boolean;
  /** Deepest Steam discount active then (estimated trend only). */
  readonly sale?: number;
}

export interface ChartSeries {
  /** Every point to read with the crosshair, oldest first: estimate before the handover, then measured. */
  readonly points: readonly ChartPoint[];
  /** The dashed line (it ends on the handover point, so the lines join). */
  readonly estimate: readonly PlayerPoint[];
  /** The solid line. */
  readonly recorded: readonly PlayerPoint[];
  readonly estimated: boolean;
  readonly kind: "cycle" | "trend" | null;
  /** Where measured data takes over (trend with recordings only), for the "tracking began" marker. */
  readonly handover: string | null;
}

/** What the chart draws: measured readings, the labelled estimate, or both (a trend before tracking). */
export function chartSeries(history: PlayerHistory): ChartSeries {
  const kind = history.estimate?.kind ?? null;
  // A cycle estimate only stands in when fewer than 2 readings exist.
  const estimate = history.estimate && !(kind === "cycle" && history.points.length >= 2) ? history.estimate.points : [];
  const recorded = history.points;
  const first = recorded[0]?.t ?? null;
  const before = estimate.filter((p) => !first || p.t < first);
  return {
    points: [
      ...before.map((p) => ({ t: p.t, players: p.players, estimated: true, ...((p as EstimatePoint).sale ? { sale: (p as EstimatePoint).sale } : {}) })),
      ...recorded.map((p) => ({ t: p.t, players: p.players, estimated: false })),
    ],
    estimate,
    recorded,
    estimated: estimate.length > 0,
    kind: estimate.length > 0 ? kind : null,
    handover: kind === "trend" && estimate.length > 0 && recorded.length >= 2 ? first : null,
  };
}

function PlayerCaption({ history }: { history: PlayerHistory }) {
  const { estimated, kind } = chartSeries(history);
  const since = history.recordingSince
    ? utcDayFormat.format(new Date(`${history.recordingSince}T00:00:00Z`))
    : null;
  const itad = history.peak24h?.source === "itad" || history.peakAllTime?.source === "itad";
  const release = history.estimate?.releaseDay
    ? utcDayFormat.format(new Date(`${history.estimate.releaseDay}T00:00:00Z`))
    : null;
  const sales = history.estimate?.sales ?? 0;
  return (
    <p className="mt-2 text-xs leading-relaxed text-slate-500">
      {kind === "trend" ? (
        <>
          <span className="font-medium text-slate-400">
            The dashed line is an estimated historical trend, not measured.
          </span>{" "}
          It starts at the game&rsquo;s all-time peak
          {history.estimate?.basis === "itad" ? " (IsThereAnyDeal)" : " (recorded)"}
          {release ? ` at its release on ${release}` : " at release"}, eases toward today&rsquo;s level, and rises
          during Steam sales from IsThereAnyDeal&rsquo;s price history ({sales === 1 ? "1 sale" : `${sales} sales`} in this
          range), more for deeper discounts. Real peaks can fall at other times.{" "}
          {since && history.recording === "ok"
            ? `The solid line is SteamGauge’s own recording, hourly since ${since}. `
            : "SteamGauge’s own hourly recording replaces it as readings come in. "}
        </>
      ) : estimated ? (
        <>
          <span className="font-medium text-slate-400">The dashed line is an estimate, not measured.</span>{" "}
          SteamGauge has too few readings of this game for this range yet, so the line follows a typical
          daily cycle, ending on the live Steam count
          {history.estimate?.basis === "itad" ? " and scaled to IsThereAnyDeal's 24-hour and 7-day peaks" : ""}.
          It shows the likely shape, not real values.{" "}
        </>
      ) : since ? (
        `Recorded by SteamGauge since ${since}: hourly for watched games, and whenever someone views a game. `
      ) : (
        "Recorded by SteamGauge hourly for watched games, and whenever someone views a game. "
      )}
      {itad ? "Peaks marked IsThereAnyDeal are tracked from Steam by IsThereAnyDeal. " : ""}
      The current count comes from Steam.
    </p>
  );
}

function peakNote(
  peak: PlayerHistory["peak24h"],
  kind: "day" | "all",
  since: string | null,
  now: number,
): string {
  if (!peak) return kind === "day" ? "No count in the last 24 hours" : "No count yet";
  if (peak.source === "itad" && kind === "all") {
    return since
      ? `IsThereAnyDeal's overall peak · SteamGauge hourly tracking since ${since}`
      : "IsThereAnyDeal's overall peak · SteamGauge hourly tracking has just begun";
  }
  if (peak.source === "itad") return "From IsThereAnyDeal";
  if (peak.source === "live") return "At least this: only the live count is known";
  if (!peak.at) return "Recorded";
  return kind === "day"
    ? `Recorded ${when(peak.at, now)}`
    : `Recorded ${dayFormat.format(new Date(peak.at))}${since ? ` · since ${since}` : ""}`;
}

export function PlayerStats({ history, now = Date.now() }: { history: PlayerHistory; now?: number }) {
  const since = history.recordingSince
    ? utcDayFormat.format(new Date(`${history.recordingSince}T00:00:00Z`))
    : null;
  const allTime = history.peakAllTime;
  return (
    <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard
        value={history.current?.count ?? null}
        label="players right now"
        note={history.current ? `From Steam, ${ago(history.current.asOf, now)}` : "Steam didn't return a count just now"}
        live={history.current !== null}
      />
      <StatCard value={history.peak24h?.players ?? null} label="24-hour peak" note={peakNote(history.peak24h, "day", since, now)} />
      <StatCard
        value={allTime?.players ?? null}
        label={allTime?.source === "recorded" ? "all-time peak (recorded)" : "all-time peak"}
        note={peakNote(allTime, "all", since, now)}
      />
    </dl>
  );
}

function StatCard({
  value,
  label,
  note,
  live = false,
}: {
  value: number | null;
  label: string;
  note: string;
  live?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-2xl border border-slate-800 bg-chrome px-4 py-3.5">
      <dt className="order-2 mt-0.5 flex items-center gap-1.5 text-sm text-slate-400">
        {live ? (
          <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: PLAYER_SERIES_COLOR }} />
        ) : null}
        {label}
      </dt>
      <dd className="order-1 text-3xl font-semibold leading-tight tracking-tight text-white tabular-nums">
        {value === null ? <span className="text-slate-500">—</span> : wholeNumber.format(value)}
      </dd>
      <dd className="order-3 mt-1 text-xs text-slate-500">{note}</dd>
    </div>
  );
}

// =============================================================================
// Range buttons (above the chart)
// =============================================================================

function RangeButtons({
  selected,
  available,
  recordingSince,
  loading,
  onSelect,
}: {
  selected: PlayerRangeId;
  available: ReadonlySet<PlayerRangeId>;
  recordingSince: string | null;
  loading: boolean;
  onSelect: (range: PlayerRangeId) => void;
}) {
  const since = recordingSince ? utcDayFormat.format(new Date(`${recordingSince}T00:00:00Z`)) : null;
  return (
    <div role="group" aria-label="Time range" className="mt-4 flex flex-wrap items-center gap-1">
      {PLAYER_RANGES.map((range) => {
        const enabled = available.has(range.id);
        return (
          <button
            key={range.id}
            type="button"
            aria-pressed={range.id === selected}
            disabled={!enabled}
            title={enabled ? undefined : since ? `Recorded since ${since}` : "Nothing recorded yet"}
            onClick={() => onSelect(range.id)}
            className={`min-h-8 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 disabled:cursor-not-allowed disabled:text-slate-700 disabled:hover:bg-transparent ${
              range.id === selected ? "bg-slate-700 text-slate-50" : "text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            }`}
          >
            {range.label}
          </button>
        );
      })}
      {loading ? (
        <span role="status" className="ml-2 text-[11px] text-slate-500">
          Loading…
        </span>
      ) : null}
    </div>
  );
}

// =============================================================================
// Chart
// =============================================================================

/** What one point means, for the tooltip ("highest in this hour") and the table. */
export function bucketPhrase(seconds: number): { tooltip: string; column: string } {
  if (seconds <= 600) return { tooltip: "highest in this 10-minute slot", column: "highest in each 10 minutes" };
  if (seconds <= 3600) return { tooltip: "highest in this hour", column: "highest each hour" };
  if (seconds < 86_400) {
    const hours = Math.round(seconds / 3600);
    return { tooltip: `highest in these ${hours} hours`, column: `highest in each ${hours} hours` };
  }
  if (seconds === 86_400) return { tooltip: "highest that day", column: "highest each day" };
  return { tooltip: "highest that week", column: "highest each week" };
}

function pointLabel(point: PlayerPoint, bucketSeconds: number, isLive: boolean): string {
  const date = new Date(point.t);
  if (isLive) return `Now (${timeFormat.format(date)})`;
  if (bucketSeconds < 86_400) return dayTimeFormat.format(date);
  if (bucketSeconds === 86_400) return utcDayFormat.format(date);
  return `Week of ${utcDayFormat.format(date)}`;
}

/** A round axis maximum: 1, 2, 2.5 or 5 times a power of ten, at or above the peak. */
export function niceMax(value: number): number {
  if (value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
  return 10 * power;
}

/**
 * Splits the points where readings are missing for more than three buckets,
 * so the line breaks instead of drawing through a gap.
 */
export function segmentsOf(points: readonly PlayerPoint[], bucketSeconds: number): PlayerPoint[][] {
  const out: PlayerPoint[][] = [];
  let current: PlayerPoint[] = [];
  const maxGap = Math.max(3 * bucketSeconds, 2 * 3600) * 1000;
  for (const point of points) {
    const previous = current.at(-1);
    if (previous && Date.parse(point.t) - Date.parse(previous.t) > maxGap) {
      out.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) out.push(current);
  return out;
}

export function PlayerHistoryChart({ history, now = Date.now() }: { history: PlayerHistory; now?: number }) {
  const [active, setActive] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const series = chartSeries(history);
  const { points, estimated, kind } = series;
  // A cycle estimate is on an hourly (1w) or 20-minute (48h) grid; a trend on days or weeks.
  const estimateStep = kind === "cycle" ? (history.range === "48h" ? 1200 : 3600) : Math.max(history.bucketSeconds, 86_400);
  const liveIndex = history.current ? points.findIndex((p) => p.t === history.current?.asOf) : -1;

  if (points.length < 2) {
    const noCount = history.current === null;
    return (
      <div className="mt-2 flex h-44 flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 bg-chrome px-6 text-center sm:h-52">
        <p className="text-sm font-medium text-slate-200">
          {noCount ? "No player count to chart yet" : "Not enough readings yet for this range"}
        </p>
        <p className="mt-1 max-w-md text-xs leading-relaxed text-slate-400">
          {noCount
            ? "Steam didn't return a live count for this game, so there is nothing to chart or estimate from. "
            : `${points.length === 1 ? "One reading so far. " : ""}The chart fills in as SteamGauge records this game’s player count. ${history.trendAvailable ? "" : "Try 48h or 1w for an estimate. "}`}
          The full history is on SteamDB.
        </p>
      </div>
    );
  }

  // --- Scales ------------------------------------------------------------------
  const range = PLAYER_RANGES.find((r) => r.id === history.range);
  const firstMs = Date.parse(points[0]!.t);
  const lastMs = Date.parse(points.at(-1)!.t);
  const endMs = Math.max(lastMs, now);
  // A fixed range starts at its span, unless recording began later: then at
  // the first reading, so the line is not squeezed into one corner.
  const startMs = range?.seconds ? Math.max(endMs - range.seconds * 1000, firstMs) : firstMs;
  const span = Math.max(endMs - startMs, 1);
  const peak = Math.max(...points.map((p) => p.players));
  const top = niceMax(peak);
  const xOf = (iso: string) => ((Date.parse(iso) - startMs) / span) * 100;
  const yOf = (players: number) => 100 - (players / top) * 92; // 8% headroom

  const pathsOf = (segments: PlayerPoint[][]) => ({
    line: segments
      .map((segment) => segment.map((p, i) => `${i === 0 ? "M" : "L"} ${xOf(p.t).toFixed(2)} ${yOf(p.players).toFixed(2)}`).join(" "))
      .join(" "),
    area: segments
      .filter((segment) => segment.length > 1)
      .map(
        (segment) =>
          `M ${xOf(segment[0]!.t).toFixed(2)} 100 ` +
          segment.map((p) => `L ${xOf(p.t).toFixed(2)} ${yOf(p.players).toFixed(2)}`).join(" ") +
          ` L ${xOf(segment.at(-1)!.t).toFixed(2)} 100 Z`,
      )
      .join(" "),
  });
  const measured = pathsOf(series.recorded.length >= 2 ? segmentsOf(series.recorded, history.bucketSeconds) : []);
  // An estimate is continuous by construction: one segment, never split on gaps.
  const modelled = pathsOf(series.estimate.length >= 2 ? [[...series.estimate]] : []);
  const handoverX = series.handover ? xOf(series.handover) : null;

  // --- Interaction -------------------------------------------------------------
  const nearest = (clientX: number, rect: DOMRect) => {
    const percent = ((clientX - rect.left) / rect.width) * 100;
    let best = 0;
    let bestDistance = Infinity;
    points.forEach((p, i) => {
      const distance = Math.abs(xOf(p.t) - percent);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  };
  const onPointer = (event: PointerEvent<HTMLDivElement>) =>
    setActive(nearest(event.clientX, event.currentTarget.getBoundingClientRect()));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = active ?? points.length - 1;
    if (event.key === "ArrowLeft") setActive(Math.max(0, current - 1));
    else if (event.key === "ArrowRight") setActive(Math.min(points.length - 1, current + 1));
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(points.length - 1);
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  };
  const activePoint = active === null ? null : (points[active] ?? null);
  const phrase = bucketPhrase(history.bucketSeconds);
  const approx = (point: ChartPoint | null | undefined) => (point?.estimated ? "≈ " : "");
  const shortSpan = span < 3 * 86_400_000;
  const longSpan = span > 300 * 86_400_000;
  const xLabel = (ms: number) =>
    shortSpan
      ? dayTimeFormat.format(new Date(ms))
      : longSpan
        ? monthYearFormat.format(new Date(ms))
        : shortDayFormat.format(new Date(ms));
  const recordedPeak = series.recorded.length ? Math.max(...series.recorded.map((p) => p.players)) : null;
  const summary =
    kind === "trend"
      ? `Concurrent players from ${xLabel(startMs)} to now: an estimated historical trend (not measured)` +
        `${series.handover ? ` until ${xLabel(Date.parse(series.handover))}, then SteamGauge's recordings` : ""}. ` +
        `Estimated highest ≈ ${wholeNumber.format(peak)}${recordedPeak !== null && series.handover ? `, recorded highest ${wholeNumber.format(recordedPeak)}` : ""}, latest ${wholeNumber.format(points.at(-1)!.players)}.`
      : `${estimated ? "Estimated concurrent players (not measured)" : "Concurrent players"} from ${xLabel(startMs)} to now. ` +
        `Highest ${estimated ? "≈ " : ""}${wholeNumber.format(peak)}, latest ${wholeNumber.format(points.at(-1)!.players)}.`;

  return (
    <div className="mt-2 rounded-2xl border border-slate-800 bg-chrome p-3 sm:p-4">
      {estimated ? (
        // Legend: only for what is drawn. Solid = measured, dashed = estimated.
        <ul aria-label="Legend" className="mb-2 ml-12 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
          {series.recorded.length >= 2 ? (
            <li className="flex items-center gap-2">
              <svg aria-hidden="true" width="18" height="4" className="shrink-0">
                <line x1="0" x2="18" y1="2" y2="2" stroke={PLAYER_SERIES_COLOR} strokeWidth="2" />
              </svg>
              <span className="font-medium text-slate-300">Recorded by SteamGauge</span>
            </li>
          ) : null}
          <li className="flex items-center gap-2">
            <svg aria-hidden="true" width="18" height="4" className="shrink-0">
              <line x1="0" x2="18" y1="2" y2="2" stroke={PLAYER_SERIES_COLOR} strokeWidth="2" strokeDasharray="5 4" />
            </svg>
            <span className="font-medium uppercase tracking-wide text-slate-300">
              {kind === "trend" ? "Estimated historical trend" : "Estimated · not measured"}
            </span>
          </li>
        </ul>
      ) : null}
      <div className="flex gap-2">
        {/* Y labels, each centred on its gridline (top, middle, zero). */}
        <div aria-hidden="true" className="relative h-40 w-10 shrink-0 text-right text-[10px] tabular-nums leading-none text-slate-500 sm:h-48">
          {[top, top / 2, 0].map((value) => (
            <span key={value} className="absolute right-0 -translate-y-1/2" style={{ top: `${yOf(value)}%` }}>
              {compactNumber.format(value)}
            </span>
          ))}
        </div>

        <div
          role="group"
          tabIndex={0}
          aria-label={`${summary} Use the left and right arrow keys to read each point.`}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? points.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          className="relative h-40 min-w-0 flex-1 cursor-crosshair touch-pan-y rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 sm:h-48"
        >
          <svg aria-hidden="true" viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
            {[yOf(top), yOf(top / 2), 100].map((y, i) => (
              <line key={i} x1="0" x2="100" y1={y} y2={y} stroke={GRID_COLOR} strokeWidth="1" vectorEffect="non-scaling-stroke" />
            ))}
            {modelled.line ? (
              <>
                <path d={modelled.area} fill={PLAYER_SERIES_COLOR} fillOpacity="0.06" />
                <path
                  d={modelled.line}
                  fill="none"
                  stroke={PLAYER_SERIES_COLOR}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null}
            {measured.line ? (
              <>
                <path d={measured.area} fill={PLAYER_SERIES_COLOR} fillOpacity="0.12" />
                <path
                  d={measured.line}
                  fill="none"
                  stroke={PLAYER_SERIES_COLOR}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </>
            ) : null}
            {handoverX !== null ? (
              <line x1={handoverX} x2={handoverX} y1="0" y2="100" stroke="#64748b" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
            ) : null}
          </svg>
          {handoverX !== null && series.handover ? (
            <span
              aria-hidden="true"
              className={`pointer-events-none absolute top-0 whitespace-nowrap text-[10px] text-slate-400 ${handoverX > 70 ? "-translate-x-full pr-1" : "pl-1"}`}
              style={{ left: `${handoverX}%` }}
            >
              Tracking began {(longSpan ? dayFormat : shortDayFormat).format(new Date(series.handover))}
            </span>
          ) : null}


          {activePoint ? (
            <>
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-slate-500"
                style={{ left: `${xOf(activePoint.t)}%` }}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-[#0b0e14]"
                style={{ left: `${xOf(activePoint.t)}%`, top: `${yOf(activePoint.players)}%`, backgroundColor: PLAYER_SERIES_COLOR }}
              />
              <div
                role="status"
                className={`pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs shadow-lg ${
                  yOf(activePoint.players) < 45 ? "" : "-translate-y-full"
                }`}
                style={{
                  left: `${Math.min(Math.max(xOf(activePoint.t), 16), 84)}%`,
                  top:
                    yOf(activePoint.players) < 45
                      ? `calc(${yOf(activePoint.players)}% + 12px)`
                      : `calc(${yOf(activePoint.players)}% - 12px)`,
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ backgroundColor: PLAYER_SERIES_COLOR }} />
                  <span className="font-semibold tabular-nums text-slate-50">
                    {active === liveIndex ? "" : approx(activePoint)}
                    {wholeNumber.format(activePoint.players)} players
                  </span>
                </span>
                <span className="mt-0.5 block text-slate-400">
                  {pointLabel(activePoint, activePoint.estimated ? estimateStep : history.bucketSeconds, active === liveIndex)}
                  {active === liveIndex
                    ? " · from Steam"
                    : activePoint.estimated
                      ? ` · estimated${activePoint.sale ? ` · during a ${activePoint.sale}% Steam sale` : ""}`
                      : ` · ${phrase.tooltip}`}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div aria-hidden="true" className="ml-12 mt-1.5 flex justify-between text-[10px] leading-none text-slate-500">
        <span>{xLabel(startMs)}</span>
        <span className="hidden sm:inline">{xLabel((startMs + endMs) / 2)}</span>
        <span>Now</span>
      </div>

      {/* Table view: every value, without hovering. Rows built only when opened. */}
      <details
        className="mt-3 text-xs text-slate-400"
        onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setTableOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none hover:text-slate-200">
          {kind === "cycle" ? "Show estimated player counts as a table" : "Show player counts as a table"}
        </summary>
        <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-slate-800">
          <table className="w-full text-left">
            <caption className="sr-only">{summary}</caption>
            <thead className="sticky top-0 bg-slate-900 text-slate-300">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">
                  {kind === "cycle" || history.bucketSeconds < 86_400 ? "Time" : history.bucketSeconds === 86_400 ? "Day" : "Week"}
                </th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">
                  {kind === "cycle" ? "Players (estimated, except the last row)" : estimated ? "Players" : `Players (${phrase.column})`}
                </th>
                {estimated ? (
                  <th scope="col" className="px-3 py-1.5 font-medium">
                    Source
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {(tableOpen ? [...points].reverse() : []).map((p) => (
                <tr key={p.t} className="border-t border-slate-800/70">
                  <td className="px-3 py-1">
                    {pointLabel(p, p.estimated ? estimateStep : history.bucketSeconds, p.t === history.current?.asOf)}
                  </td>
                  <td className="px-3 py-1 text-right tabular-nums text-slate-200">
                    {approx(p)}
                    {wholeNumber.format(p.players)}
                  </td>
                  {estimated ? (
                    <td className="px-3 py-1 text-slate-500">
                      {p.t === history.current?.asOf
                        ? "Steam (now)"
                        : p.estimated
                          ? `Estimated${p.sale ? ` · ${p.sale}% sale` : ""}`
                          : "Recorded"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function PlayerSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading player counts">
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-[6.5rem] animate-pulse rounded-2xl border border-slate-800 bg-chrome" />
        ))}
      </div>
      <div className="mt-4 h-8 w-80 max-w-full animate-pulse rounded bg-slate-800/60" />
      <div className="mt-2 h-52 animate-pulse rounded-2xl border border-slate-800 bg-chrome sm:h-60" />
    </div>
  );
}
