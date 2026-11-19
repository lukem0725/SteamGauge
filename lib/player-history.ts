/**
 * lib/player-history.ts
 *
 * Concurrent-player history (v1.11): chart ranges and the answer of
 * GET /api/apps/[appid]/players. Pure; shared by the browser and the server.
 *
 * Three kinds of number, never mixed (v1.11.1):
 *   measured   the live count from Steam, and SteamGauge's own recordings
 *              (migration 0004). `points` holds only these.
 *   ITAD       IsThereAnyDeal's player stats (24-hour, 7-day and all-time
 *              peak, tracked from Steam), used for the peak cards.
 *   estimated  `estimate`, drawn dashed, labelled in the legend, and never
 *              fed into a stat card. Two kinds:
 *                cycle  48h and 1w with fewer than 2 readings: a typical
 *                       daily cycle ending on the live count (v1.11.1)
 *                trend  1m and longer, for the time before SteamGauge's
 *                       tracking began: from the all-time peak at release,
 *                       easing to today's level, with rises during Steam
 *                       sales from ITAD's price history (v1.11.2)
 */

export type PlayerRangeId = "48h" | "1w" | "1m" | "3m" | "6m" | "1y" | "3y" | "6y" | "max";

const HOUR = 3600;
const DAY = 86_400;

export interface PlayerRange {
  readonly id: PlayerRangeId;
  readonly label: string;
  /** Span in seconds; null for "max" (everything recorded). */
  readonly seconds: number | null;
  /**
   * Bucket size: the chart shows the highest reading per bucket. Under a day
   * comes from 10-minute rows (kept 31 days); a day or more from daily peaks.
   * Chosen so no range draws more than about 400 points.
   */
  readonly bucketSeconds: number;
}

export const PLAYER_RANGES: readonly PlayerRange[] = [
  { id: "48h", label: "48h", seconds: 2 * DAY, bucketSeconds: 600 },
  { id: "1w", label: "1w", seconds: 7 * DAY, bucketSeconds: HOUR },
  { id: "1m", label: "1m", seconds: 30 * DAY, bucketSeconds: 4 * HOUR },
  { id: "3m", label: "3m", seconds: 91 * DAY, bucketSeconds: DAY },
  { id: "6m", label: "6m", seconds: 182 * DAY, bucketSeconds: DAY },
  { id: "1y", label: "1y", seconds: 365 * DAY, bucketSeconds: DAY },
  { id: "3y", label: "3y", seconds: 3 * 365 * DAY, bucketSeconds: 7 * DAY },
  { id: "6y", label: "6y", seconds: 6 * 365 * DAY, bucketSeconds: 7 * DAY },
  { id: "max", label: "max", seconds: null, bucketSeconds: DAY },
];

export const DEFAULT_PLAYER_RANGE: PlayerRangeId = "48h";

export function isPlayerRange(value: unknown): value is PlayerRangeId {
  return PLAYER_RANGES.some((range) => range.id === value);
}

export function playerRange(id: PlayerRangeId): PlayerRange {
  return PLAYER_RANGES.find((range) => range.id === id) as PlayerRange;
}

/** "max" shows daily peaks up to about 400 days of history, weekly beyond. */
export function maxBucketSeconds(recordingSince: string | null, now = Date.now()): number {
  if (!recordingSince) return DAY;
  const days = (now - Date.parse(`${recordingSince}T00:00:00Z`)) / (DAY * 1000);
  return days > 400 ? 7 * DAY : DAY;
}

/**
 * Ranges worth offering: every range up to the first that covers all recorded
 * history, plus "max". Longer ones would only draw the same points smaller.
 */
export function availableRanges(recordingSince: string | null, now = Date.now()): ReadonlySet<PlayerRangeId> {
  const out = new Set<PlayerRangeId>(["max"]);
  const historySeconds = recordingSince
    ? Math.max(0, (now - Date.parse(`${recordingSince}T00:00:00Z`)) / 1000)
    : 0;
  for (const range of PLAYER_RANGES) {
    if (range.seconds === null) continue;
    out.add(range.id);
    if (range.seconds >= historySeconds) break;
  }
  return out;
}

export interface PlayerPoint {
  /** Start of the bucket (ISO). */
  readonly t: string;
  /** Highest reading in the bucket. */
  readonly players: number;
}

/**
 * Where a peak came from:
 *   recorded  SteamGauge's own readings (with the time of the reading)
 *   itad      IsThereAnyDeal's player stats (no time given)
 *   live      only the current count is known, so this is a lower bound
 */
export type PeakSource = "recorded" | "itad" | "live";

export interface PlayerPeak {
  readonly players: number;
  /** When that reading was taken (ISO); null when the source gives no time. */
  readonly at: string | null;
  readonly source: PeakSource;
}

/** The higher of two peaks; on a tie the more informative source wins. */
export function higherPeak(a: PlayerPeak | null, b: PlayerPeak | null): PlayerPeak | null {
  if (!a) return b;
  if (!b) return a;
  if (a.players !== b.players) return a.players > b.players ? a : b;
  const rank: Record<PeakSource, number> = { recorded: 2, itad: 1, live: 0 };
  return rank[a.source] >= rank[b.source] ? a : b;
}

export interface EstimatePoint extends PlayerPoint {
  /** Deepest Steam discount active in this bucket (trend only), for the tooltip. */
  readonly sale?: number;
}

export interface PlayerEstimate {
  /**
   * Oldest first. A cycle ends on the live count; a trend ends on the first
   * recorded point (or the live count), so the two lines join.
   */
  readonly points: readonly EstimatePoint[];
  /** What the curve is anchored on, for the caption. */
  readonly basis: "itad" | "live" | "recorded";
  readonly kind: "cycle" | "trend";
  /** Trend only: the release day the curve starts from ("YYYY-MM-DD"). */
  readonly releaseDay?: string | null;
  /** Trend only: how many Steam sales from ITAD's price history shaped it. */
  readonly sales?: number;
}

export type RecordingStatus = "ok" | "unavailable";

export interface PlayerHistory {
  readonly appid: number;
  readonly range: PlayerRangeId;
  readonly bucketSeconds: number;
  /** From Steam, at most 10 minutes old. Null when Steam has no count. */
  readonly current: { readonly count: number; readonly asOf: string } | null;
  /** Highest in the last 24 hours: the higher of our recordings, ITAD, and `current`. */
  readonly peak24h: PlayerPeak | null;
  /** Highest ever: the higher of our recordings, ITAD's all-time peak, and `current`. */
  readonly peakAllTime: PlayerPeak | null;
  /** First UTC day with a recording ("YYYY-MM-DD"), or null. */
  readonly recordingSince: string | null;
  /** "unavailable" when the recordings could not be read (for example, migration 0004 not run). */
  readonly recording: RecordingStatus;
  /** Measured only, oldest first. The last point is the current count when there is one. */
  readonly points: readonly PlayerPoint[];
  /** A labelled estimate (see the file header), or null. */
  readonly estimate: PlayerEstimate | null;
  /**
   * True when a historical trend can be drawn for 1m and longer (an all-time
   * peak from ITAD or recordings, and a release date), so those ranges are offered.
   */
  readonly trendAvailable: boolean;
}

// =============================================================================
// Estimate (v1.11.1)
// =============================================================================

/** Ranges an estimate is offered for. Longer ones would be a guess with nothing to anchor it. */
export const ESTIMATE_RANGES: ReadonlySet<PlayerRangeId> = new Set<PlayerRangeId>(["48h", "1w"]);

/**
 * Ranges worth offering: recorded history, plus 48h and 1w when a cycle can
 * be estimated (a live count), plus every range when a historical trend can.
 */
export function offeredRanges(
  recordingSince: string | null,
  canEstimate: boolean,
  now = Date.now(),
  trendAvailable = false,
): ReadonlySet<PlayerRangeId> {
  if (trendAvailable) return new Set(PLAYER_RANGES.map((range) => range.id));
  const out = new Set(availableRanges(recordingSince, now));
  if (canEstimate) for (const id of ESTIMATE_RANGES) out.add(id);
  return out;
}

export interface EstimateInput {
  readonly rangeId: PlayerRangeId;
  /** The live count: required, the curve ends on it. */
  readonly current: { readonly count: number; readonly asOf: string } | null;
  /** Best known 24-hour peak (ITAD or recorded); null if unknown. */
  readonly dayPeak: number | null;
  /** Best known 7-day peak (ITAD); null if unknown. */
  readonly weekPeak: number | null;
  /** Seeds the small variation so the same game always gets the same curve. */
  readonly appid: number;
}

// Model constants. Concurrent players on Steam follow a daily cycle with one
// evening-in-Europe/afternoon-in-the-Americas peak around 14:00-16:00 UTC and
// a trough about half the peak; weekends run higher. The constants are a
// generic shape, not fitted to any one game, which is why the result is
// always labelled as an estimate.
const PEAK_HOUR_UTC = 15;
const TROUGH_RATIO = 0.5;
/** With only the live count known, a gentler cycle keeps the guessed peak near it. */
const TROUGH_RATIO_LIVE_ONLY = 0.7;
const ANCHOR_HOURS = 4;
/** Small, so the line reads as a model rather than as measured noise. */
const NOISE = 0.01;

/** 0 at the daily trough, 1 at the daily peak. */
function dailyShape(ms: number): number {
  const hour = (ms / 3_600_000) % 24;
  return (1 + Math.cos(((hour - PEAK_HOUR_UTC) / 24) * 2 * Math.PI)) / 2;
}

/** How "weekend" a UTC day is: Sat/Sun 1, Fri 0.5, else 0. */
function weekendness(ms: number): number {
  const day = new Date(ms).getUTCDay();
  return day === 0 || day === 6 ? 1 : day === 5 ? 0.5 : 0;
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A plausible curve for the last 48 hours or week, ending on the live count.
 * Today's peak matches `dayPeak` and the week's highest day approaches
 * `weekPeak` where those are known. Returns null without a live count, or
 * for ranges other than 48h and 1w.
 */
export function estimatePlayerSeries(input: EstimateInput, now = Date.now()): PlayerPoint[] | null {
  const { current, rangeId } = input;
  if (!current || !ESTIMATE_RANGES.has(rangeId)) return null;
  const range = playerRange(rangeId);
  const span = (range.seconds as number) * 1000;
  const step = rangeId === "48h" ? 20 * 60_000 : 3_600_000;
  const endMs = Math.min(Date.parse(current.asOf), now);
  const count = current.count;

  const trough = input.dayPeak === null ? TROUGH_RATIO_LIVE_ONLY : TROUGH_RATIO;
  const shapeNow = dailyShape(endMs);
  const fromLive = count / (trough + (1 - trough) * shapeNow);
  const dayPeak = Math.max(input.dayPeak ?? fromLive, count);

  // Weekend lift, scaled so the week's best day reaches the 7-day peak.
  const ratio = input.weekPeak && input.weekPeak > dayPeak ? Math.min(input.weekPeak / dayPeak, 1.6) : 1.08;
  const wNow = weekendness(endMs);
  // Solve (1 + k) / (1 + k * wNow) = ratio for k. On a weekend day the week's
  // best day is today, so no lift can reach a higher 7-day peak: use a small one.
  const denominator = 1 - ratio * wNow;
  const k = denominator > 0.05 ? Math.min(Math.max((ratio - 1) / denominator, 0), 0.8) : 0.08;
  const dayFactor = (ms: number) => (1 + k * weekendness(ms)) / (1 + k * wNow);

  const raw = (ms: number) => dayPeak * dayFactor(ms) * (trough + (1 - trough) * dailyShape(ms));
  const correction = count - raw(endMs);
  const random = seededRandom(input.appid * 2_654_435_761 + (rangeId === "48h" ? 1 : 2));

  const points: PlayerPoint[] = [];
  const startMs = Math.ceil((endMs - span) / step) * step;
  for (let ms = startMs; ms < endMs - step / 2; ms += step) {
    const anchor = correction * Math.exp(-(endMs - ms) / (ANCHOR_HOURS * 3_600_000));
    const jitter = 1 + (random() * 2 - 1) * NOISE;
    points.push({ t: new Date(ms).toISOString(), players: Math.max(0, Math.round((raw(ms) + anchor) * jitter)) });
  }
  points.push({ t: new Date(endMs).toISOString(), players: count });
  return points;
}


// =============================================================================
// Historical trend (v1.11.2): 1m and longer, before tracking began
// =============================================================================

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Steam's release date strings ("21 Aug, 2012", "Aug 21, 2012", "Aug 2012")
 * to a UTC day "YYYY-MM-DD". Null for "Coming soon", "Q1 2027" and the like.
 */
export function parseSteamReleaseDate(display: string | null | undefined): string | null {
  if (!display) return null;
  const text = display.trim().toLowerCase().replace(/\./g, "");
  let day = 1;
  let month = -1;
  let year = NaN;
  let m = /^(\d{1,2}) ([a-z]{3})[a-z]*,? (\d{4})$/.exec(text);
  if (m) [day, month, year] = [Number(m[1]), MONTHS.indexOf(m[2]!), Number(m[3])];
  else if ((m = /^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4})$/.exec(text))) [month, day, year] = [MONTHS.indexOf(m[1]!), Number(m[2]), Number(m[3])];
  else if ((m = /^([a-z]{3})[a-z]* (\d{4})$/.exec(text))) [month, year] = [MONTHS.indexOf(m[1]!), Number(m[2])];
  if (month < 0 || !(year >= 1997 && year <= 2100) || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month, day));
  return date.getUTCMonth() === month ? date.toISOString().slice(0, 10) : null;
}

/** A Steam sale from ITAD's price log: from a discounted price change to the next change. */
export interface SaleWindow {
  readonly start: number;
  readonly end: number;
  readonly discountPercent: number;
}

/** Sales of at least 20% off, each at most 21 days long. */
export function saleWindows(
  prices: readonly { readonly date: string; readonly discountPercent: number }[],
  now = Date.now(),
): SaleWindow[] {
  const sorted = [...prices].sort((a, b) => a.date.localeCompare(b.date));
  const out: SaleWindow[] = [];
  sorted.forEach((point, i) => {
    if (point.discountPercent < 20) return;
    const start = Date.parse(`${point.date}T00:00:00Z`);
    const next = sorted[i + 1];
    const end = next ? Date.parse(`${next.date}T00:00:00Z`) : Math.min(now, start + 14 * DAY * 1000);
    out.push({ start, end: Math.min(Math.max(end, start + DAY * 1000), start + 21 * DAY * 1000), discountPercent: point.discountPercent });
  });
  return out;
}

export interface TrendInput {
  readonly appid: number;
  readonly rangeId: PlayerRangeId;
  /** First UTC day on Steam. */
  readonly releaseDay: string;
  /** All-time peak (ITAD or recorded); the curve reaches it at release. */
  readonly allTimePeak: number;
  /** Where the estimate hands over to measured data, and the value there. */
  readonly endAt: string;
  readonly endPlayers: number;
  readonly sales: readonly SaleWindow[];
  /** Points are the highest daily value in each bucket of this size (a day or more). */
  readonly bucketSeconds: number;
}

// Trend model: most Steam games peak in their launch weeks and settle over a
// few months; sales bring a rise that is larger for deeper discounts and
// fades after the sale. A generic shape, which is why it is labelled.
const LAUNCH_DECAY_DAYS = 75;
const SALE_LIFT_AT_100 = 0.6;
const SALE_TAIL_DAYS = 5;
const TREND_NOISE = 0.02;

/** Multiplier from active or just-ended sales on one day, and the deepest discount active. */
function saleLift(ms: number, sales: readonly SaleWindow[]): { lift: number; active: number } {
  let lift = 1;
  let active = 0;
  for (const sale of sales) {
    if (ms < sale.start || ms > sale.end + SALE_TAIL_DAYS * 4 * DAY * 1000) continue;
    const full = SALE_LIFT_AT_100 * (sale.discountPercent / 100) ** 1.2;
    let value: number;
    if (ms <= sale.end) {
      const progress = (ms - sale.start) / Math.max(sale.end - sale.start, 1);
      value = full * (1 - 0.5 * progress);
      active = Math.max(active, sale.discountPercent);
    } else {
      value = 0.5 * full * Math.exp(-(ms - sale.end) / (SALE_TAIL_DAYS * DAY * 1000));
    }
    lift = Math.max(lift, 1 + value);
  }
  return { lift, active };
}

/**
 * The estimated trend from release (or the range start, if later) up to
 * `endAt`, one point per bucket (the highest day in it). The first day after
 * release equals the all-time peak; the curve never exceeds it; the last
 * point is exactly `endPlayers` at `endAt`. Null when there is nothing before
 * `endAt` to estimate.
 */
export function estimateHistoricalTrend(input: TrendInput, now = Date.now()): EstimatePoint[] | null {
  const dayMs = DAY * 1000;
  const release = Date.parse(`${input.releaseDay}T00:00:00Z`);
  const endMs = Date.parse(input.endAt);
  const range = playerRange(input.rangeId);
  const rangeStart = range.seconds === null ? release : Math.max(release, now - range.seconds * 1000);
  if (!Number.isFinite(release) || !Number.isFinite(endMs) || rangeStart >= endMs - dayMs) return null;

  const end = Math.max(0, input.endPlayers);
  const peak = Math.max(input.allTimePeak, end);
  const daysTotal = (endMs - release) / dayMs;
  const base = (ms: number) => {
    const days = (ms - release) / dayMs;
    // Eases from the peak at release to the end level, reaching it at endAt.
    const decay = Math.exp(-days / LAUNCH_DECAY_DAYS);
    const decayAtEnd = Math.exp(-daysTotal / LAUNCH_DECAY_DAYS);
    const share = decayAtEnd >= 1 ? 0 : (decay - decayAtEnd) / (1 - decayAtEnd);
    return end + (peak - end) * share;
  };
  const random = seededRandom(input.appid * 40_503 + 7);

  // Daily values, then the highest day per bucket.
  const bucketMs = Math.max(input.bucketSeconds, DAY) * 1000;
  const firstDay = Math.floor(rangeStart / dayMs) * dayMs;
  const buckets = new Map<number, { players: number; sale: number }>();
  for (let ms = firstDay; ms < endMs - dayMs / 2; ms += dayMs) {
    const atRelease = ms - release < dayMs;
    const { lift, active } = saleLift(ms, input.sales);
    const jitter = atRelease ? 1 : 1 + (random() * 2 - 1) * TREND_NOISE;
    const players = Math.round(Math.min(peak, atRelease ? peak : base(ms) * lift * jitter));
    const key = Math.floor(ms / bucketMs) * bucketMs;
    const prev = buckets.get(key);
    buckets.set(key, { players: Math.max(prev?.players ?? 0, players), sale: Math.max(prev?.sale ?? 0, active) });
  }
  const points: EstimatePoint[] = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({ t: new Date(Math.max(ms, firstDay)).toISOString(), players: v.players, ...(v.sale ? { sale: v.sale } : {}) }));
  points.push({ t: new Date(endMs).toISOString(), players: end });
  return points.length >= 2 ? points : null;
}
