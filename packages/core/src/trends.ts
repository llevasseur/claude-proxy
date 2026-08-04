import { isPartialDay } from './time.js';

/** Anything bucketed by report-timezone day — every digest-shaped series here. */
export interface DayLabelled {
  date: string;
}

/**
 * The window's finished days, in the order given. The current day is still being
 * written to, so its totals are a part-day figure and it is left out.
 */
export function endOfDaySnapshots<T extends DayLabelled>(days: readonly T[], now?: Date): T[] {
  return days.filter((d) => !isPartialDay(d.date, now));
}

/** The window's closing day set against the last date that recorded the statistic. */
export interface ClosingComparison<T> {
  /** The newest day in the window — the value being reported. */
  closing: T;
  /** The latest earlier day whose value was non-zero, or null when none was. */
  baseline: T | null;
  /** Percent change from `baseline` to `closing`; null without a baseline. */
  deltaPct: number | null;
}

/**
 * The closing day against the last date that actually recorded this statistic,
 * skipping back over any that read zero.
 *
 * An idle day is a gap in the record rather than a measurement of zero, so it
 * cannot be what a trend is read against: a zero baseline divides by nothing, so
 * the delta is suppressed and the movement goes unreported even though the day
 * it should be compared to is sitting further back in the same window. Which
 * date that is depends on the statistic, so the scan takes the value accessor
 * rather than a whole-day emptiness test.
 */
export function lastNonZeroComparison<T>(days: readonly T[], value: (d: T) => number): ClosingComparison<T> | null {
  const closing = days.at(-1);
  if (!closing) return null;
  const now = value(closing);
  for (let i = days.length - 2; i >= 0; i -= 1) {
    const baseline = days[i]!;
    const was = value(baseline);
    if (was > 0) return { closing, baseline, deltaPct: ((now - was) / was) * 100 };
  }
  return { closing, baseline: null, deltaPct: null };
}

/** One statistic blended across a window: a ratio of two totals, not a mean of daily values. */
export interface BlendedRate {
  /** `numerator / denominator`. */
  value: number;
  numerator: number;
  denominator: number;
  /** Days that carried a non-zero denominator, and so had a say in the value. */
  days: number;
}

/**
 * `Σ num / Σ den` across the window — a rate weighted by volume rather than by
 * day, so it is not the mean of each day's own rate. `null` when nothing was
 * captured or every denominator was zero.
 */
export function blendRate<T>(days: readonly T[], num: (d: T) => number, den: (d: T) => number): BlendedRate | null {
  let numerator = 0;
  let denominator = 0;
  let counted = 0;
  for (const d of days) {
    const weight = den(d);
    if (weight <= 0) continue;
    numerator += num(d);
    denominator += weight;
    counted += 1;
  }
  if (denominator <= 0) return null;
  return { value: numerator / denominator, numerator, denominator, days: counted };
}
