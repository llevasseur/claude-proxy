import { costPerMTok, rateTokens, type UsageDigest } from "./digest.js";

/**
 * One day as the cost-against-tokens plot draws it. Volume is the x, spend the
 * y, and `rate` is the slope of the line from the origin through the point —
 * which is what makes two days of very different sizes comparable.
 */
export interface CostRatePoint {
  date: string;
  /** Prompt + output tokens. */
  tokens: number;
  /** Estimated USD for the day. */
  cost: number;
  /** `cost` over `tokens`, in USD per million. */
  rate: number;
}

const toPoint = (d: UsageDigest): CostRatePoint => ({
  date: d.date,
  tokens: rateTokens(d),
  cost: d.cost.total,
  rate: costPerMTok(d),
});

/**
 * Every day in the window that moved tokens, oldest first. A day with none has
 * no rate to plot — an undefined slope, not a cheap day — so it is dropped
 * rather than pinned to the origin.
 */
export function costRatePoints(digests: readonly UsageDigest[]): CostRatePoint[] {
  return digests.filter((d) => rateTokens(d) > 0).map(toPoint);
}

/** Middle value of an ascending list; the mean of the middle two when it is even. */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The bar the newest day is measured against: the median $/MTok of the days
 * before it. The newest day is excluded so it cannot move the baseline it is
 * being judged by, and a median rather than a blended window rate keeps one
 * enormous day from setting the bar on its own. `null` when no earlier day
 * moved tokens, which is the case on a first day of capture.
 */
export function baselineRate(digests: readonly UsageDigest[]): number | null {
  const prior = costRatePoints(digests.slice(0, -1));
  if (prior.length === 0) return null;
  return median(prior.map((p) => p.rate).sort((a, b) => a - b));
}

/** The newest day's rate stated against the baseline, ready to render. */
export interface CostRateSummary {
  /** The newest day in the window; `null` when it moved no tokens. */
  today: CostRatePoint | null;
  baseline: number | null;
  /** Today against the baseline, in percent — negative is cheaper. `null` without both. */
  deltaPct: number | null;
}

export function summarizeCostRate(digests: readonly UsageDigest[]): CostRateSummary {
  const last = digests.at(-1);
  const today = last && rateTokens(last) > 0 ? toPoint(last) : null;
  const baseline = baselineRate(digests);
  const deltaPct = today && baseline !== null && baseline > 0 ? ((today.rate - baseline) / baseline) * 100 : null;
  return { today, baseline, deltaPct };
}
