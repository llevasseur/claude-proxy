import { costPerMTok, rateTokens, type UsageDigest } from './digest.js';

/**
 * One day as the cost-against-tokens plot draws it: volume on x, spend on y,
 * `rate` the slope from the origin through the point.
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
 * an undefined slope, not a cheap one, so it is dropped rather than plotted.
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
 * before it. Excluding the newest keeps it from moving its own baseline, and a
 * median keeps one enormous day from setting the bar alone. `null` when no
 * earlier day moved tokens.
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
