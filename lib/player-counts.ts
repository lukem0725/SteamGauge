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
 *   notePlayerInterest  called when a game's details are opened, so the
 *                       sampler keeps reading it for 14 days
 *   samplePlayers       GET /api/cron/sample-players: reads watched and
 *                       recently viewed games so their history has no gaps
 *
 * The readings are kept for a future measured chart; nothing shows them
 * since v1.12, when the estimated player chart was removed. Database
 * failures here are logged as a short code and never fail a page.
 */
import { getCurrentPlayers, type EndpointContext } from "@/lib/steam/endpoints";
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
