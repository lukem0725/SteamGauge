/**
 * lib/steam/review-backfill.ts
 *
 * Fills in Steam review totals for list rows that came back without them.
 *
 * The batched GetItems call (50 apps per Web API call) is the main source of
 * review data for Deals and the Wishlist. When it leaves some apps without a
 * review summary, this module asks IUserReviewsService/GetAppReviews for
 * those apps, one call per app, within firm limits:
 *
 *   1. Cache first, in bulk. Every app's summary is cached for all users
 *      (3 days fresh, 14 days usable). One database query per 100 apps
 *      finds the ones already known. No Steam calls.
 *   2. Then at most REVIEW_LIVE_LOOKUPS apps per request, at most
 *      REVIEW_CONCURRENCY at a time, through the normal quota gate.
 *   3. The request waits at most REVIEW_WAIT_MS for those lookups. Lookups
 *      still running continue in the background (waitUntil) and land in the
 *      cache for the next request.
 *   4. The first quota or throttling failure stops the remaining lookups.
 *
 * So a cold deals table fills in over a few page loads, and a warm one
 * costs only database reads.
 */
import "server-only";

import { CachedFetchError } from "./cached-fetch";
import { getAppReviews, peekAppReviews, type EndpointContext, type ReviewSummary } from "./endpoints";

/** New GetAppReviews calls started per request. */
export const REVIEW_LIVE_LOOKUPS = 30;
/** GetAppReviews calls in flight at once. */
export const REVIEW_CONCURRENCY = 4;
/** How long a request waits for live lookups before answering. */
export const REVIEW_WAIT_MS = 2_500;
/** Rows considered per request (the deals table holds at most 1,000). */
const MAX_TARGETS = 1_000;

export interface ReviewTarget {
  readonly appid: number;
  /** Null means "no review data", the only case this module fills in. */
  readonly reviewCount: number | null;
  /** Unreleased games have no reviews to fetch. */
  readonly comingSoon: boolean;
}

export interface BackfillResult {
  /** Summaries found for rows that had none. */
  readonly summaries: ReadonlyMap<number, ReviewSummary>;
  /** Rows still without review data after this request. */
  readonly pending: number;
}

export interface BackfillOptions {
  readonly liveLookups?: number;
  readonly concurrency?: number;
  readonly waitMs?: number;
}

/**
 * Never throws: on any failure the rows simply keep their missing values.
 * Targets are processed in the order given, so pass the most important first.
 */
export async function backfillReviews(
  targets: readonly ReviewTarget[],
  ctx: EndpointContext,
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const liveLimit = options.liveLookups ?? REVIEW_LIVE_LOOKUPS;
  const concurrency = Math.max(1, options.concurrency ?? REVIEW_CONCURRENCY);
  const waitMs = options.waitMs ?? REVIEW_WAIT_MS;

  const seen = new Set<number>();
  const need: number[] = [];
  for (const target of targets) {
    if (target.reviewCount !== null || target.comingSoon || seen.has(target.appid)) continue;
    seen.add(target.appid);
    need.push(target.appid);
    if (need.length >= MAX_TARGETS) break;
  }
  if (need.length === 0) return { summaries: new Map(), pending: 0 };

  const summaries = new Map<number, ReviewSummary>();
  try {
    for (const [appid, summary] of await peekAppReviews(need)) summaries.set(appid, summary);
  } catch {
    // Bulk read failed; fall through to the bounded live lookups.
  }

  const live = need.filter((appid) => !summaries.has(appid)).slice(0, liveLimit);
  if (live.length > 0) {
    // Lookups write into `fetched`; only what arrives before the deadline is
    // copied into the answer, so late results cannot change it afterwards.
    const fetched = new Map<number, ReviewSummary>();
    let stopped = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!stopped && next < live.length) {
        const appid = live[next++]!;
        try {
          const result = await getAppReviews(appid, ctx);
          if (result.status === "ok") fetched.set(appid, result.data);
        } catch (err) {
          if (
            err instanceof CachedFetchError &&
            (err.reason === "quota_exhausted" || err.reason === "throttled")
          ) {
            stopped = true;
          }
        }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(concurrency, live.length) }, worker)).then(
      () => undefined,
    );

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), waitMs);
    });
    const outcome = await Promise.race([all.then(() => "done" as const), deadline]);
    if (timer) clearTimeout(timer);
    if (outcome === "late") ctx.waitUntil?.(all);

    for (const [appid, summary] of fetched) summaries.set(appid, summary);
  }

  return { summaries, pending: need.length - summaries.size };
}
