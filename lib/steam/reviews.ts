/**
 * lib/steam/reviews.ts
 *
 * Parser for IUserReviewsService/GetAppReviews, the keyless Web API method
 * that replaced store.steampowered.com/appreviews/{appid}?json=1 when Valve
 * retired that URL on 2026-10-22 (it now redirects to the store front page).
 *
 * Only the first page's `query_summary` is used: total reviews and total
 * positive. Pure, no I/O.
 */
import { z } from "zod";

export interface ReviewSummary {
  readonly appid: number;
  /** Total Steam-purchaser reviews in every language. 0 means none yet. */
  readonly count: number;
  /** Share positive, 0-100. Null when there are no reviews. */
  readonly percent: number | null;
  /** Steam's wording, e.g. "Very Positive". Null when there are no reviews. */
  readonly label: string | null;
}

/** A count as a number or a numeric string (64-bit fields arrive as strings). */
const count = z
  .union([z.number(), z.string().regex(/^\d{1,12}$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER));

const summarySchema = z.object({
  total_reviews: count.optional(),
  total_positive: count,
  total_negative: count.optional(),
  review_score_desc: z.string().max(64).optional().catch(undefined),
});

/**
 * @returns the summary; "not_found" when Steam sent an empty response (an
 *          appid it does not know).
 * @throws ZodError when the response has an unexpected shape.
 */
export function parseAppReviews(
  raw: unknown,
  appid: number,
): { status: "ok"; data: ReviewSummary } | { status: "not_found" } {
  // The Web API wraps the reply in "response". Accept the bare shape too.
  const body =
    raw && typeof raw === "object" && "response" in raw ? (raw as { response: unknown }).response : raw;
  if (!body || typeof body !== "object") throw new Error("reviews response is not an object");
  const summaryRaw = (body as { query_summary?: unknown }).query_summary;
  if (summaryRaw === undefined) {
    if (Object.keys(body).length === 0) return { status: "not_found" };
    throw new Error("reviews response has no query_summary");
  }
  const summary = summarySchema.parse(summaryRaw);
  // total_reviews, or positive + negative when it is missing or smaller.
  const sum = summary.total_positive + (summary.total_negative ?? 0);
  const total = Math.max(summary.total_reviews ?? 0, sum);
  const positive = Math.min(summary.total_positive, total);
  return {
    status: "ok",
    data: {
      appid,
      count: total,
      percent: total > 0 ? Math.round((positive / total) * 100) : null,
      label: total > 0 ? (summary.review_score_desc ?? null) : null,
    },
  };
}

/** Narrows a cached payload back to a ReviewSummary, or null if it is not one. */
export function asReviewSummary(value: unknown): ReviewSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!Number.isInteger(v.appid) || !Number.isInteger(v.count) || (v.count as number) < 0) return null;
  if (v.percent !== null && typeof v.percent !== "number") return null;
  return {
    appid: v.appid as number,
    count: v.count as number,
    percent: v.percent as number | null,
    label: typeof v.label === "string" ? v.label : null,
  };
}
