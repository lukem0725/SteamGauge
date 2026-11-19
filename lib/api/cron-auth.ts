import "server-only";

/**
 * lib/api/cron-auth.ts
 *
 * The check every /api/cron/* route makes: `Authorization: Bearer $CRON_SECRET`,
 * compared in constant time. An unset or short secret never authorizes
 * anything. (Moved out of the price-tracking route in v1.11 so the player
 * sampler shares it.)
 */
import { timingSafeEqual } from "node:crypto";

export function isCronAuthorized(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
