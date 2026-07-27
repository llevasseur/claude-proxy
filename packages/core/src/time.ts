/**
 * The reporting timezone for every day-bucketed number in the dashboard.
 *
 * Sidecars are stamped in UTC, but a "day" should line up with the wall clock
 * you were actually working against. Bucketing on the raw UTC prefix rolls the
 * day over at 19:00/20:00 Eastern, so an evening's work lands on tomorrow.
 * `America/New_York` is Eastern proper — EST in winter, EDT in summer — so the
 * boundary stays at local midnight year-round.
 */
export const REPORT_TZ = "America/New_York";

const dayFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// `hourCycle: "h23"` avoids V8's "24" for midnight.
const hourFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TZ,
  hour: "2-digit",
  hourCycle: "h23",
});

const abbrFmt = new Intl.DateTimeFormat("en-US", { timeZone: REPORT_TZ, timeZoneName: "short" });

function toDate(at: string | Date): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `YYYY-MM-DD` for `at` in {@link REPORT_TZ}; `null` when `at` is unparseable. */
export function reportDay(at: string | Date): string | null {
  const d = toDate(at);
  if (!d) return null;
  const p: Record<string, string> = {};
  for (const part of dayFmt.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

/** Hour of day (0–23) for `at` in {@link REPORT_TZ}; `null` when unparseable. */
export function reportHour(at: string | Date): number | null {
  const d = toDate(at);
  if (!d) return null;
  const h = Number(hourFmt.format(d));
  return Number.isNaN(h) ? null : h;
}

/** Short zone label in effect at `at`, e.g. `"EST"` or `"EDT"`. */
export function reportTzAbbr(at: Date = new Date()): string {
  return abbrFmt.formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "ET";
}

/**
 * `YYYY-MM-DD` for `n` days from the `YYYY-MM-DD` label `from`. Pure label
 * arithmetic on a calendar date, so it carries no timezone of its own.
 */
export function shiftDay(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
