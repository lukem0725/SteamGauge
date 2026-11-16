/**
 * lib/value.ts
 *
 * The "bang for your buck" maths, shared by the server (deals ranking) and
 * the browser (dashboard, deals list) so a game gets the same numbers
 * everywhere. Pure functions, no I/O, safe to import on either side.
 *
 *   utility score = price / completion time = cost per hour (lower is better)
 */

/**
 * SIMULATED game length, in hours.
 *
 * We have no real "time to beat" data source. This derives a stable number
 * between 4 and 60 from the AppID, so a game always shows the same figure,
 * skewed toward shorter games. It says nothing true about the actual game and
 * is labelled "simulated" wherever it is shown. Replace this one function
 * when a real source is wired in; every score and ranking follows from it.
 */
export function simulatedHoursToBeat(appid: number): number {
  const unit = (Math.imul(appid, 0x9e3779b1) >>> 0) / 0x1_0000_0000; // 0..1, deterministic
  return Math.round(4 + unit * unit * 56);
}

/**
 * Cost per hour in the currency's minor unit (cents), rounded to a whole
 * number. `priceMinorUnits` is the current price; `hours` must be positive.
 */
export function costPerHour(priceMinorUnits: number, hours: number): number {
  return hours > 0 ? Math.round(priceMinorUnits / hours) : priceMinorUnits;
}

/** 4 is best. Drives the four-segment meter. */
export type ValueLevel = 1 | 2 | 3 | 4;

export interface ValueRating {
  readonly level: ValueLevel;
  readonly label: string;
}

/**
 * Rating thresholds, in cents per hour:
 *   up to 100  Great value      up to 500  Fair value
 *   up to 250  Good value       above 500  Pricey per hour
 */
export function rateValue(centsPerHour: number): ValueRating {
  if (centsPerHour <= 100) return { level: 4, label: "Great value" };
  if (centsPerHour <= 250) return { level: 3, label: "Good value" };
  if (centsPerHour <= 500) return { level: 2, label: "Fair value" };
  return { level: 1, label: "Pricey per hour" };
}
