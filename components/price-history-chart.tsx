"use client";

/**
 * components/price-history-chart.tsx
 *
 * A single-series price chart: what the store charged over time, as recorded
 * by SteamGauge (lib/price-history.ts).
 *
 *   - Step line. A price holds until it changes, so the line is flat between
 *     observations rather than sloping between them.
 *   - One series, so no legend: the heading above the chart names it.
 *   - The lowest recorded price is marked with a green dot and a "Low" label.
 *   - Hover, touch, or arrow keys move a crosshair that reads out the price
 *     on that day. Nothing is hover-only: the same data is in the table view.
 *
 * The SVG stretches to any width (it has no text in it); labels, markers and
 * the tooltip are HTML positioned by percentage, so nothing is distorted and
 * no resize listener is needed.
 */
import { useState, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from "react";

import { formatMoney } from "@/components/ui-kit";
import type { PriceHistory, PricePoint } from "@/lib/price-history";

/**
 * Series colour: a Steam blue between steam-500 and steam-600. The brighter
 * steam-400 (#66c0f4) is too light for a data mark on this dark card (OKLCH L
 * 0.77, above the 0.48-0.67 band); #3a9ad6 passes the lightness, contrast and
 * colour-blind separation checks against the green low marker and #141922.
 */
const SERIES_COLOR = "#3a9ad6";
/** Reserved "good" status colour. Only ever used with a text label beside it. */
const LOW_COLOR = "#0ca30c";
const SURFACE_COLOR = "#141922";

/**
 * Time ranges. All four buttons are always shown; "All" is the default, so a
 * multi-year history shows its full trend first. A range longer than the
 * history is disabled (it would look the same as "All"), with the start date
 * in its tooltip.
 */
const RANGES = [
  { id: "6m", label: "6M", days: 183 },
  { id: "1y", label: "1Y", days: 365 },
  { id: "2y", label: "2Y", days: 730 },
  { id: "all", label: "All", days: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];
const DAY_MS = 86_400_000;

export interface PriceHistoryChartProps {
  readonly history: PriceHistory;
  /** Injectable for tests and previews. Defaults to the current time. */
  readonly now?: Date;
}

export function PriceHistoryChart({ history, now = new Date() }: PriceHistoryChartProps) {
  const [active, setActive] = useState<number | null>(null);
  const [rangeId, setRangeId] = useState<RangeId>("all");
  const [tableOpen, setTableOpen] = useState(false);

  const currency = history.currency ?? "USD";
  const today = startOfUtcDay(now.getTime());
  const firstMs = history.points[0] ? toMs(history.points[0].date) : today;
  const covers = (r: (typeof RANGES)[number]) => r.days === null || firstMs < today - r.days * DAY_MS;
  const selected = RANGES.find((r) => r.id === rangeId);
  const range = selected && covers(selected) ? selected : RANGES[RANGES.length - 1]!;
  const points = windowPoints(history.points, range.days === null ? null : today - range.days * DAY_MS);

  if (points.length === 0) {
    return (
      <p className="rounded-xl border border-slate-800 px-3 py-4 text-center text-xs text-slate-500">
        No price recorded yet. The chart fills in as prices are checked.
      </p>
    );
  }

  // --- Scales ---------------------------------------------------------------
  const first = points[0] as PricePoint;
  const last = points[points.length - 1] as PricePoint;
  const xStart = toMs(first.date);
  // The last known price is drawn forward to today. A lone point gets a
  // one-day span so there is a line to draw.
  const xEnd = Math.max(today, toMs(last.date), xStart + DAY_MS);
  const xOf = (ms: number) => ((ms - xStart) / (xEnd - xStart)) * 100;

  const values = points.map((p) => p.final);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // Pad so the line never sits on the frame. A flat series is centred.
  const pad = hi === lo ? Math.max(hi * 0.1, 50) : (hi - lo) * 0.15;
  const yMin = Math.max(0, lo - pad);
  const yMax = hi + pad;
  const yOf = (value: number) => 100 - ((value - yMin) / (yMax - yMin)) * 100;

  // --- Step path --------------------------------------------------------------
  let path = `M ${xOf(xStart).toFixed(2)} ${yOf(first.final).toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    const p = points[i] as PricePoint;
    path += ` H ${xOf(toMs(p.date)).toFixed(2)} V ${yOf(p.final).toFixed(2)}`;
  }
  path += ` H 100`;

  // --- Markers ----------------------------------------------------------------
  const lowIndex = lastIndexOfMin(points);
  const lowPoint = points[lowIndex] as PricePoint;
  const showLowMarker = hi !== lo; // a flat line has no low worth pointing at
  const lowAtRightEdge = xOf(toMs(lowPoint.date)) > 85;
  const activePoint = active === null ? null : (points[active] ?? null);

  // --- Interaction ------------------------------------------------------------
  const nearestIndex = (clientX: number, rect: DOMRect) => {
    const percent = ((clientX - rect.left) / rect.width) * 100;
    let best = 0;
    let bestDistance = Infinity;
    points.forEach((p, i) => {
      const distance = Math.abs(xOf(toMs(p.date)) - percent);
      if (distance < bestDistance) {
        best = i;
        bestDistance = distance;
      }
    });
    return best;
  };
  const onPointer = (event: PointerEvent<HTMLDivElement>) =>
    setActive(nearestIndex(event.clientX, event.currentTarget.getBoundingClientRect()));
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

  const summary =
    `Price history from ${formatDay(first.date, now)} to today. ` +
    `Lowest ${formatMoney(lo, currency)}, highest ${formatMoney(hi, currency)}, ` +
    `latest ${formatMoney(last.final, currency)}.`;

  return (
    <div>
      <div className="flex gap-2">
        {/* Y labels: just the range. A tick on every gridline would be noise. */}
        <div
          aria-hidden="true"
          className="flex w-12 shrink-0 flex-col justify-between py-0.5 text-right text-[10px] tabular-nums leading-none text-slate-500"
        >
          <span>{formatMoney(hi, currency)}</span>
          {hi !== lo ? <span>{formatMoney(lo, currency)}</span> : null}
        </div>

        <div
          role="group"
          tabIndex={0}
          aria-label={`${summary} Use the left and right arrow keys to read each day.`}
          onPointerMove={onPointer}
          onPointerDown={onPointer}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((current) => current ?? points.length - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
          className="relative h-28 min-w-0 flex-1 cursor-crosshair touch-pan-y rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
          >
            {/* Recessive hairline grid: top, middle, bottom. */}
            {[yOf(hi), yOf((hi + lo) / 2), yOf(lo)].map((y, i) => (
              <line
                key={i}
                x1="0"
                x2="100"
                y1={y}
                y2={y}
                stroke="#263241"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path
              d={path}
              fill="none"
              stroke={SERIES_COLOR}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Crosshair: finds the day so the reader never has to hit the line. */}
          {activePoint ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-slate-500"
              style={{ left: `${xOf(toMs(activePoint.date))}%` }}
            />
          ) : null}

          {/* Latest price, at the right edge. */}
          <Dot x={100} y={yOf(last.final)} color={SERIES_COLOR} />

          {showLowMarker ? (
            <>
              <Dot x={xOf(toMs(lowPoint.date))} y={yOf(lowPoint.final)} color={LOW_COLOR} />
              {/* Below the dot, or to its left when the low is at the right edge,
                  where a label underneath would run into the "Today" axis label. */}
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute rounded-sm bg-surface-raised px-0.5 text-[10px] font-medium leading-none text-slate-300 ${
                  lowAtRightEdge ? "-translate-x-full -translate-y-1/2" : "-translate-x-1/2"
                }`}
                style={
                  lowAtRightEdge
                    ? { left: `calc(${xOf(toMs(lowPoint.date))}% - 8px)`, top: `${yOf(lowPoint.final)}%` }
                    : {
                        left: `${clamp(xOf(toMs(lowPoint.date)), 6, 94)}%`,
                        top: `calc(${yOf(lowPoint.final)}% + 8px)`,
                      }
                }
              >
                Low
              </span>
            </>
          ) : null}

          {activePoint ? (
            <>
              <Dot
                x={xOf(toMs(activePoint.date))}
                y={yOf(activePoint.final)}
                color={SERIES_COLOR}
              />
              <div
                role="status"
                // Above the point, or below it when the point is near the top,
                // so the readout stays inside the chart instead of covering
                // the text above it.
                className={`pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs shadow-lg ${
                  yOf(activePoint.final) < 45 ? "" : "-translate-y-full"
                }`}
                style={{
                  left: `${clamp(xOf(toMs(activePoint.date)), 18, 82)}%`,
                  top:
                    yOf(activePoint.final) < 45
                      ? `calc(${yOf(activePoint.final)}% + 10px)`
                      : `calc(${yOf(activePoint.final)}% - 10px)`,
                }}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="h-0.5 w-3 rounded-full"
                    style={{ backgroundColor: SERIES_COLOR }}
                  />
                  <span className="font-semibold tabular-nums text-slate-50">
                    {formatMoney(activePoint.final, currency)}
                  </span>
                  {activePoint.discountPercent > 0 ? (
                    <span className="tabular-nums text-slate-400">
                      -{activePoint.discountPercent}%
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-slate-400">
                  {formatDay(activePoint.date, now)}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </div>

      {/* X labels */}
      <div
        aria-hidden="true"
        className="ml-14 mt-1.5 flex justify-between text-[10px] leading-none text-slate-500"
      >
        <span>{formatDay(first.date, now)}</span>
        {xEnd - xStart > 400 * DAY_MS ? (
          <span>{formatDay(new Date((xStart + xEnd) / 2).toISOString().slice(0, 10), now)}</span>
        ) : null}
        <span>Today</span>
      </div>

      <div role="group" aria-label="Time range" className="ml-14 mt-2 flex flex-wrap items-center gap-1">
        {RANGES.map((r) => {
          const available = covers(r);
          return (
            <button
              key={r.id}
              type="button"
              aria-pressed={r.id === range.id}
              disabled={!available}
              title={available ? undefined : `History starts ${formatDay(first.date, now)}`}
              onClick={() => {
                setRangeId(r.id);
                setActive(null);
              }}
              className={`min-h-8 rounded-md px-2.5 text-xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400 disabled:cursor-not-allowed disabled:text-slate-700 disabled:hover:bg-transparent ${
                r.id === range.id
                  ? "bg-slate-700 text-slate-50"
                  : "text-slate-500 hover:bg-slate-800 hover:text-slate-300"
              }`}
            >
              {r.label}
            </button>
          );
        })}
        <span className="ml-1 text-[11px] text-slate-600">
          {range.days === null ? `Since ${formatDay(first.date, now)}` : null}
        </span>
      </div>

      {/* Table view: every value in the chart, without hovering. Its rows are
          built only once it is opened: a closed <details> shows nothing, and
          a few hundred formatted rows made every chart slow to appear. */}
      <details
        className="mt-2 text-xs text-slate-400"
        onToggle={(event: SyntheticEvent<HTMLDetailsElement>) => setTableOpen(event.currentTarget.open)}
      >
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md text-slate-500 hover:text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-steam-400">
          Show price changes as a table
        </summary>
        <table className="mt-1 w-full border-collapse text-left tabular-nums">
          <caption className="sr-only">{summary}</caption>
          <thead>
            <tr className="border-b border-slate-800 text-slate-500">
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Date
              </th>
              <th scope="col" className="py-1.5 pr-3 font-medium">
                Price
              </th>
              <th scope="col" className="py-1.5 font-medium">
                Discount
              </th>
            </tr>
          </thead>
          <tbody>
            {(tableOpen ? priceChanges(points) : []).map((p) => (
              <tr key={p.date} className="border-b border-slate-800/60">
                <td className="py-1.5 pr-3">{formatDay(p.date, now)}</td>
                <td className="py-1.5 pr-3 text-slate-200">{formatMoney(p.final, currency)}</td>
                <td className="py-1.5">{p.discountPercent > 0 ? `-${p.discountPercent}%` : "None"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}

/** An 8px marker with a 2px ring in the surface colour so it reads over the line. */
function Dot({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        backgroundColor: color,
        boxShadow: `0 0 0 2px ${SURFACE_COLOR}`,
      }}
    />
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function toMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The most recent day the lowest price was seen. */
function lastIndexOfMin(points: readonly PricePoint[]): number {
  let index = 0;
  points.forEach((p, i) => {
    if (p.final <= (points[index] as PricePoint).final) index = i;
  });
  return index;
}

/** The first day, plus every day the price differed from the day before it. */
function priceChanges(points: readonly PricePoint[]): PricePoint[] {
  return points.filter((p, i) => i === 0 || p.final !== (points[i - 1] as PricePoint).final);
}

/** "Oct 12", or "Oct 12, 2025" when the year differs from the current one. */
// Built once: creating an Intl formatter per call cost ~50 ms per opened chart
// with a few hundred price changes (v1.9). Output is identical to
// toLocaleDateString with the same options.
const DAY_FORMAT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatDay(day: string, now: Date = new Date()): string {
  const date = new Date(toMs(day));
  if (Number.isNaN(date.getTime())) return day;
  return (date.getUTCFullYear() !== now.getUTCFullYear() ? DAY_YEAR_FORMAT : DAY_FORMAT).format(date);
}

/**
 * Points inside the window. A step line needs the price in force when the
 * window opens, so the last point before it is carried forward to its start.
 * Exported for tests.
 */
export function windowPoints(points: readonly PricePoint[], startMs: number | null): PricePoint[] {
  if (startMs === null) return [...points];
  const inside = points.filter((p) => toMs(p.date) >= startMs);
  const before = points.filter((p) => toMs(p.date) < startMs).at(-1);
  if (!before) return inside;
  const startDay = new Date(startMs).toISOString().slice(0, 10);
  if (inside[0]?.date === startDay) return inside;
  return [{ ...before, date: startDay }, ...inside];
}
