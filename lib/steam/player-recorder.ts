import "server-only";

/**
 * lib/steam/player-recorder.ts
 *
 * Saves one live concurrent-player reading (v1.11, migration 0004). Called
 * after every refresh of GetNumberOfCurrentPlayers (endpoints.getCurrentPlayers),
 * so every page that shows a live count also records it at no extra Steam
 * cost. Its own module so endpoints.ts and lib/player-counts.ts can both use
 * it without importing each other.
 *
 * Never throws: a missed reading only leaves a gap in a chart. Failures are
 * logged as a Postgres error code, nothing else.
 */
import { getSupabaseAdmin } from "@/lib/supabase/server";

export async function recordPlayerCount(appid: number, players: number, at = new Date()): Promise<void> {
  if (!Number.isInteger(appid) || appid <= 0 || !Number.isInteger(players) || players < 0) return;
  try {
    const { error } = await getSupabaseAdmin().rpc("record_player_count", {
      p_appid: appid,
      p_players: players,
      p_at: at.toISOString(),
    });
    if (error) {
      const code = (error as { code?: unknown }).code;
      console.warn(
        JSON.stringify({
          area: "player_counts",
          event: "record_failed",
          detail: typeof code === "string" && /^[A-Z0-9]{5}$/.test(code) ? code : "unknown",
        }),
      );
    }
  } catch {
    console.warn(JSON.stringify({ area: "player_counts", event: "record_failed", detail: "exception" }));
  }
}
