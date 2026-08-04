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
