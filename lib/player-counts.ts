import "server-only";

/**
 * lib/player-counts.ts
 *
 * SteamGauge's own concurrent-player recordings (v1.11, migration 0004).
 *
 *   recordPlayerCount   called after every live GetNumberOfCurrentPlayers
 *                       read (endpoints.getCurrentPlayers), so any page that
 *                       shows a player count also records it, at no extra
 *                       Steam cost
 *   buildPlayerHistory  GET /api/apps/[appid]/players: live count, ITAD
 *                       peaks, recordings, and a labelled estimate when too
 *                       little is recorded (v1.11.1)
 *   samplePlayers       GET /api/cron/sample-players: reads watched and
 *                       recently viewed games so their history has no gaps
 *
 * Database failures here are logged as a short code and never fail the page:
 * a missing reading only leaves a gap in a chart.
 */
import { isItadConfigured } from "@/lib/itad/client";
import {
  DEFAULT_PLAYER_RANGE,
  ESTIMATE_RANGES,
  estimateHistoricalTrend,
  estimatePlayerSeries,
  higherPeak,
  parseSteamReleaseDate,
  saleWindows,
  maxBucketSeconds,
  playerRange,
  type PlayerHistory,
  type PlayerPeak,
  type PlayerPoint,
  type PlayerRangeId,
  type RecordingStatus,
} from "@/lib/player-history";
import { peekCached } from "@/lib/steam/cached-fetch";
import { getCurrentPlayers, getItadHistory, getItadPlayers, type AppDetails, type EndpointContext } from "@/lib/steam/endpoints";
import { getSupabaseAdmin } from "@/lib/supabase/server";

export { recordPlayerCount } from "@/lib/steam/player-recorder";

function logPlayers(event: string, detail?: string): void {
  console.warn(JSON.stringify({ area: "player_counts", event, ...(detail ? { detail } : {}) }));
}

function dbCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "unknown";
}

/** Keeps a viewed game on the sampler's list for 14 days. Never throws. */
export async function notePlayerInterest(appid: number): Promise<void> {
  try {
    const { error } = await getSupabaseAdmin().rpc("note_player_interest", { p_appid: appid });
    if (error) logPlayers("interest_failed", dbCode(error));
  } catch {
    logPlayers("interest_failed", "exception");
  }
}

// =============================================================================
// GET /api/apps/[appid]/players
// =============================================================================

interface StatsRow {
  peak_24h: number | null;
  peak_24h_at: string | null;
  peak_all: number | null;
  peak_all_at: string | null;
  first_day: string | null;
}

function asStats(data: unknown): StatsRow {
  const row = (Array.isArray(data) ? data[0] : data) as Partial<StatsRow> | null | undefined;
  const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : null);
  const iso = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
  const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    peak_24h: int(row?.peak_24h),
    peak_24h_at: iso(row?.peak_24h_at),
    peak_all: int(row?.peak_all),
    peak_all_at: iso(row?.peak_all_at),
    first_day: day(row?.first_day),
  };
}

function asPoints(data: unknown): PlayerPoint[] {
  if (!Array.isArray(data)) return [];
  const out: PlayerPoint[] = [];
  for (const row of data) {
    const t = (row as { t?: unknown })?.t;
    const players = (row as { players?: unknown })?.players;
    if (typeof t !== "string" || Number.isNaN(Date.parse(t)) || !Number.isInteger(players) || (players as number) < 0) {
      continue;
    }
    out.push({ t: new Date(t).toISOString(), players: players as number });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * Current count, peaks and the chart series for one range.
 *
 * Never throws for missing data (v1.11.1). Each source fails on its own:
 *   - Steam's live count: `current` is null.
 *   - Our recordings (for example, migration 0004 not run yet): `recording`
 *     is "unavailable", recorded peaks and points are empty, and the server
 *     log says which Postgres error it was.
 *   - ITAD (no key, unknown game, or down): peaks come from recordings and
 *     the live count only.
 * With fewer than two recorded points in 48h or 1w, `estimate` carries a
 * labelled modelled curve anchored on the live count and the known peaks.
 */
export async function buildPlayerHistory(
  appid: number,
  rangeId: PlayerRangeId = DEFAULT_PLAYER_RANGE,
  context: EndpointContext,
): Promise<PlayerHistory> {
  const range = playerRange(rangeId);
  let recording: RecordingStatus = "ok";
  const recordingFailed = (event: string, error: unknown) => {
    recording = "unavailable";
    // PGRST202 / 42883 (function missing) or 42P01 (table missing) mean
    // migration 0004 has not been applied. Only the code is logged.
    logPlayers(event, dbCode(error));
  };

  let db: ReturnType<typeof getSupabaseAdmin> | null = null;
  try {
    db = getSupabaseAdmin();
  } catch (err) {
    recordingFailed("db_unavailable", err);
  }

  // The live count first: if it refreshes, it is recorded before we read peaks.
  const [current, stats, itad] = await Promise.all([
    getCurrentPlayers(appid, context)
      .then((r) => (r.status === "ok" ? { count: r.data.count, asOf: r.meta.fetchedAt } : null))
      .catch(() => null),
    db
      ? Promise.resolve(db.rpc("player_count_stats", { p_appid: appid })).then(
          ({ data, error }) => {
            if (error) {
              recordingFailed("stats_read_failed", error);
              return null;
            }
            return asStats(data);
          },
          (err: unknown) => {
            recordingFailed("stats_read_failed", err);
            return null;
          },
        )
      : null,
    isItadConfigured()
      ? getItadPlayers(appid, context)
          .then((r) => (r.status === "ok" ? r.data : null))
          .catch(() => null)
      : null,
  ]);

  // --- Peaks: the higher of our recordings, ITAD, and the live count --------
  const live: PlayerPeak | null = current ? { players: current.count, at: current.asOf, source: "live" } : null;
  const itadPeak = (players: number | null | undefined): PlayerPeak | null =>
    typeof players === "number" ? { players, at: null, source: "itad" } : null;
  const peak24h = higherPeak(
    higherPeak(
      stats?.peak_24h != null && stats.peak_24h_at
        ? { players: stats.peak_24h, at: stats.peak_24h_at, source: "recorded" }
        : null,
      itadPeak(itad?.day),
    ),
    live,
  );
  const peakAllTime = higherPeak(
    higherPeak(
      stats?.peak_all != null && stats.peak_all_at
        ? { players: stats.peak_all, at: stats.peak_all_at, source: "recorded" }
        : null,
      itadPeak(itad?.peak),
    ),
    live,
  );

  // --- Historical trend inputs (1m and longer, v1.11.2) ----------------------
  // The release day comes from the store details the game page already
  // loaded (cache only, no Storefront call), else ITAD's first logged price.
  // ITAD's Steam price log also gives the sale windows.
  const trendPeak = peakAllTime && peakAllTime.source !== "live" ? peakAllTime : null;
  const trendRange = !ESTIMATE_RANGES.has(rangeId);
  const releaseFromDetails = await releaseDayFromCache(appid);
  let prices: readonly { readonly date: string; readonly discountPercent: number }[] = [];
  if (trendRange && trendPeak && isItadConfigured()) {
    prices = await getItadHistory(appid, "us", context)
      .then((r) => (r.status === "ok" ? r.data.points : []))
      .catch(() => []);
  }
  const releaseDay = releaseFromDetails ?? prices[0]?.date ?? null;

  // --- Recorded series -------------------------------------------------------
  // "max" is daily up to about 400 days of history, weekly beyond; with a
  // trend the history starts at release.
  const bucketSeconds =
    range.seconds === null
      ? maxBucketSeconds(trendRange && trendPeak && releaseDay ? releaseDay : (stats?.first_day ?? null))
      : range.bucketSeconds;
  let points: PlayerPoint[] = [];
  if (db && stats) {
    const since = range.seconds === null ? new Date(0) : new Date(Date.now() - range.seconds * 1000);
    try {
      const series = await db.rpc("player_count_series", {
        p_appid: appid,
        p_since: since.toISOString(),
        p_bucket_seconds: bucketSeconds,
      });
      if (series.error) recordingFailed("series_read_failed", series.error);
      else points = asPoints(series.data);
    } catch (err) {
      recordingFailed("series_read_failed", err);
    }
  }
  const recordedCount = points.length;
  // End the line at the live count when it is newer than the last bucket.
  if (current) {
    const last = points.at(-1);
    if (!last || Date.parse(current.asOf) > Date.parse(last.t)) points.push({ t: current.asOf, players: current.count });
  }

  // --- Estimate ----------------------------------------------------------------
  let estimate: PlayerHistory["estimate"] = null;
  if (trendRange && trendPeak) {
    // Hand over to measured data at the first recorded point, or the live count.
    const handover = recordedCount > 0 ? points[0] : current ? { t: current.asOf, players: current.count } : null;
    if (releaseDay && handover) {
      const sales = saleWindows(prices);
      const trend = estimateHistoricalTrend({
        appid,
        rangeId,
        releaseDay,
        allTimePeak: trendPeak.players,
        endAt: handover.t,
        endPlayers: handover.players,
        sales,
        bucketSeconds: Math.max(bucketSeconds, 86_400),
      });
      if (trend) {
        const from = Date.parse(trend[0]!.t);
        estimate = {
          points: trend,
          basis: trendPeak.source,
          kind: "trend",
          releaseDay,
          sales: sales.filter((sale) => sale.end >= from && sale.start <= Date.parse(handover.t)).length,
        };
      }
    }
  } else if (recordedCount < 2 && ESTIMATE_RANGES.has(rangeId)) {
    const estimated = estimatePlayerSeries({
      rangeId,
      current,
      dayPeak: peak24h && peak24h.source !== "live" ? peak24h.players : null,
      weekPeak: itad?.week ?? null,
      appid,
    });
    if (estimated) estimate = { points: estimated, basis: itad?.day != null || itad?.week != null ? "itad" : "live", kind: "cycle" };
  }

  const today = new Date().toISOString().slice(0, 10);
  return {
    appid,
    range: rangeId,
    bucketSeconds,
    current,
    peak24h,
    peakAllTime,
    recordingSince: stats?.first_day ?? (current && recording === "ok" ? today : null),
    recording,
    points,
    estimate,
    trendAvailable: trendPeak !== null && (releaseFromDetails !== null || isItadConfigured()),
  };
}

/** The release day from cached store details, if the game page has loaded them. Never calls Steam. */
async function releaseDayFromCache(appid: number): Promise<string | null> {
  try {
    const [hit] = await peekCached("appDetails", [[appid, "us"]]);
    const details = hit?.status === "ok" ? (hit.data as AppDetails | null) : null;
    return parseSteamReleaseDate(details?.releaseDate?.display ?? null);
  } catch {
    return null;
  }
}

// =============================================================================
// GET /api/cron/sample-players
// =============================================================================

/** Games read per run. Hourly, that is at most 7,200 Web API calls a day. */
export const SAMPLE_MAX_APPS = 300;
const SAMPLE_CONCURRENCY = 5;
/** 10-minute rows older than this are dropped (daily peaks are kept). */
export const SAMPLE_KEEP_DAYS = 31;

export interface SampleRunResult {
  readonly apps: number;
  readonly read: number;
  readonly failed: number;
  readonly stoppedEarly: boolean;
  readonly purged: number;
}

/**
 * Reads the current count of watched and recently viewed games. Each read
 * goes through the cache at the background ("cron") quota tier; a fresh
 * cached count (someone looked in the last 10 minutes) is already recorded
 * and costs nothing. Stops at the first budget refusal.
 */
export async function samplePlayers(context: EndpointContext): Promise<SampleRunResult> {
  const db = getSupabaseAdmin();
  const targets = await db.rpc("player_sample_targets", { p_limit: SAMPLE_MAX_APPS });
  if (targets.error) throw new Error("sample targets read failed");
  const appids = (Array.isArray(targets.data) ? targets.data : [])
    .map((row) => (row as { appid?: unknown } | null)?.appid)
    .filter((appid): appid is number => Number.isInteger(appid) && (appid as number) > 0);

  let read = 0;
  let failed = 0;
  let stop = false;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(SAMPLE_CONCURRENCY, appids.length) }, async () => {
      while (!stop && next < appids.length) {
        const appid = appids[next++] as number;
        try {
          await getCurrentPlayers(appid, { ...context, priority: "cron" });
          read++;
        } catch (err) {
          failed++;
          const reason = (err as { reason?: unknown } | null)?.reason;
          if (reason === "quota_exhausted" || reason === "throttled") stop = true;
        }
      }
    }),
  );

  let purged = 0;
  try {
    const { data, error } = await db.rpc("purge_player_counts", { p_keep_days: SAMPLE_KEEP_DAYS });
    if (error) logPlayers("purge_failed", dbCode(error));
    else if (Number.isInteger(data)) purged = data as number;
  } catch {
    logPlayers("purge_failed", "exception");
  }

  return { apps: appids.length, read, failed, stoppedEarly: stop, purged };
}
