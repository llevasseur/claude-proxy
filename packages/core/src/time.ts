/**
 * The reporting timezone for every day-bucketed number in the dashboard.
 * Eastern proper — EST in winter, EDT in summer — so the day boundary stays at
 * local midnight year-round rather than following the sidecars' UTC stamps.
 */
export const REPORT_TZ = 'America/New_York';

const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// `hourCycle: "h23"` avoids V8's "24" for midnight.
const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ,
  hour: '2-digit',
  hourCycle: 'h23',
});

const abbrFmt = new Intl.DateTimeFormat('en-US', { timeZone: REPORT_TZ, timeZoneName: 'short' });

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

/**
 * Whether `day` is still being written to — the current day in {@link REPORT_TZ}.
 * A partial day's totals and means are not comparable with a finished one's.
 */
export function isPartialDay(day: string, now: Date = new Date()): boolean {
  return reportDay(now) === day;
}

/**
 * How much of `day` has elapsed, 0–1. Past days are 1. Lets a partial day's
 * counts be read against the fraction of the day they cover.
 */
export function dayElapsedFraction(day: string, now: Date = new Date()): number {
  if (!isPartialDay(day, now)) return 1;
  const start = dayStartMs(day);
  const elapsed = (now.getTime() - start) / 86_400_000;
  return Math.min(1, Math.max(0, elapsed));
}

/** Short zone label in effect at `at`, e.g. `"EST"` or `"EDT"`. */
export function reportTzAbbr(at: Date = new Date()): string {
  return abbrFmt.formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'ET';
}

// Wall-clock components of an instant, for turning a day label back into one.
const wallFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: REPORT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Milliseconds to add to a UTC instant to reach {@link REPORT_TZ} wall time. */
function zoneOffsetMs(at: number): number {
  const p: Record<string, string> = {};
  for (const part of wallFmt.formatToParts(new Date(at))) p[part.type] = part.value;
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wall - at;
}

/**
 * The instant local midnight opens the day labelled `day`, in {@link REPORT_TZ};
 * `NaN` when the label is unparseable.
 *
 * The offset is itself a function of the instant, so it is applied twice: the
 * first pass lands within a day of the answer, the second uses the offset actually
 * in force there. That second pass is what keeps the two DST changeovers right.
 */
export function dayStartMs(day: string): number {
  const naive = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(naive)) return NaN;
  return naive - zoneOffsetMs(naive - zoneOffsetMs(naive));
}

/** `YYYY-MM-DD` for `n` days from the label `from`. Pure label arithmetic — no timezone of its own. */
export function shiftDay(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
