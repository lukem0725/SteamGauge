/**
 * components/review-badge.tsx
 *
 * Steam's review rating, as on the store page (v1.11): the label ("Very
 * Positive") in Steam's own colour, and the numbers behind it ("94% of
 * 1,234,567 reviews are positive"). Counts are Steam purchasers in every
 * language, from IUserReviewsService/GetAppReviews.
 *
 * Steam's colours: positive #66C0F4 (blue), mixed #B9A074 (tan), negative
 * #A34C25 (red-orange). The first two pass 4.5:1 as text on our dark cards;
 * Steam's red-orange does not (3.2:1), so it tints the badge and the text
 * uses a lighter shade of it (#E0805A, 6.6:1). The label always carries the
 * meaning, never colour alone.
 */
import type { ReviewSummary } from "@/lib/steam/reviews";

export type ReviewTone = "positive" | "mixed" | "negative" | "none";

const POSITIVE = new Set(["overwhelmingly positive", "very positive", "positive", "mostly positive"]);
const NEGATIVE = new Set(["overwhelmingly negative", "very negative", "negative", "mostly negative"]);

/**
 * Tone from Steam's label; for labels Steam uses with few reviews ("7 user
 * reviews"), from the share positive using Steam's thresholds (70% / 40%).
 */
export function reviewTone(summary: Pick<ReviewSummary, "label" | "percent" | "count">): ReviewTone {
  if (summary.count === 0 || summary.percent === null) return "none";
  const label = summary.label?.trim().toLowerCase() ?? "";
  if (POSITIVE.has(label)) return "positive";
  if (label === "mixed") return "mixed";
  if (NEGATIVE.has(label)) return "negative";
  return summary.percent >= 70 ? "positive" : summary.percent >= 40 ? "mixed" : "negative";
}

const TONE_CLASS: Record<ReviewTone, string> = {
  positive: "bg-[#66c0f4]/15 text-[#66c0f4] ring-[#66c0f4]/40",
  mixed: "bg-[#b9a074]/15 text-[#b9a074] ring-[#b9a074]/40",
  negative: "bg-[#a34c25]/25 text-[#e0805a] ring-[#a34c25]/60",
  none: "bg-slate-800 text-slate-300 ring-slate-700",
};

const wholeNumber = new Intl.NumberFormat("en-US");

export function ReviewBadge({
  summary,
  state,
}: {
  summary: ReviewSummary | null;
  /** "loading" while game facts load; "unavailable" when Steam could not be asked. */
  state: "loading" | "ready" | "unavailable";
}) {
  if (state === "loading") {
    return (
      <div aria-busy="true" aria-label="Loading Steam reviews" className="flex items-center gap-2">
        <div className="h-6 w-32 animate-pulse rounded-md bg-slate-800" />
        <div className="h-4 w-48 animate-pulse rounded bg-slate-800" />
      </div>
    );
  }
  if (state === "unavailable") {
    return <p className="text-sm text-slate-400">Steam reviews are unavailable right now.</p>;
  }
  if (!summary || summary.count === 0 || summary.percent === null) {
    return <p className="text-sm text-slate-400">No Steam user reviews yet.</p>;
  }
  const tone = reviewTone(summary);
  const label = summary.label && !/user reviews?$/i.test(summary.label) ? summary.label : `${summary.percent}% positive`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="sr-only">Steam reviews: </span>
      <span className={`rounded-md px-2 py-0.5 text-sm font-semibold ring-1 ${TONE_CLASS[tone]}`}>{label}</span>
      <span className="text-sm text-slate-300">
        <span className="font-semibold tabular-nums text-slate-100">{summary.percent}%</span> of{" "}
        <span className="tabular-nums">{wholeNumber.format(summary.count)}</span>{" "}
        {summary.count === 1 ? "user review is" : "user reviews are"} positive
      </span>
    </div>
  );
}
