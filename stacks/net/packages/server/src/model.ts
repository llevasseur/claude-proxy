// Pure read-time model for the internet-spend stack: the shared delta rule,
// gap classification, local-day bucketing, period boundaries, agent
// classification and interface filtering. Decisions internet-spend 001-004.
// Like stacks/*/packages/core: no Node imports, no clock, no environment —
// deterministic over its inputs alone.

export interface NetSample {
  /** UTC epoch milliseconds. */
  readonly timestamp: number;
  readonly bootEpoch: number;
  readonly name: string;
  readonly pid: number;
  readonly interface: string;
  /** Cumulative counter — never a delta (decision internet-spend 001). */
  readonly bytesIn: number;
  /** Cumulative counter — never a delta. */
  readonly bytesOut: number;
}

/** `measured` carries bytes; `decrease` and `boot` are typed discontinuities contributing zero (decision internet-spend 002). */
export type IntervalKind = 'measured' | 'decrease' | 'boot';

export interface SampleInterval {
  readonly start: number;
  readonly end: number;
  readonly kind: IntervalKind;
  readonly bytesIn: number;
  readonly bytesOut: number;
}

/**
 * One delta rule keyed on a `(name, pid, interface)` series within equal
 * `boot_epoch`, used identically by writer and reader (decision internet-spend
 * 002). The first sample baselines only; `new >= old` yields a delta;
 * `new < old` yields a decrease discontinuity with zero bytes; a boot change
 * takes precedence as its own discontinuity type and re-baselines.
 */
export function computeDeltas(series: readonly NetSample[]): SampleInterval[] {
  const intervals: SampleInterval[] = [];
  const first = series[0];
  if (!first || series.length < 2) return intervals;
  let baseline: NetSample = first;
  for (let index = 1; index < series.length; index++) {
    const current = series[index];
    if (!current) break;
    if (current.bootEpoch !== baseline.bootEpoch) {
      intervals.push({
        start: baseline.timestamp,
        end: current.timestamp,
        kind: 'boot',
        bytesIn: 0,
        bytesOut: 0,
      });
      baseline = current;
      continue;
    }
    const previousSum = baseline.bytesIn + baseline.bytesOut;
    const currentSum = current.bytesIn + current.bytesOut;
    if (currentSum < previousSum) {
      intervals.push({
        start: baseline.timestamp,
        end: current.timestamp,
        kind: 'decrease',
        bytesIn: 0,
        bytesOut: 0,
      });
    } else {
      intervals.push({
        start: baseline.timestamp,
        end: current.timestamp,
        kind: 'measured',
        bytesIn: current.bytesIn - baseline.bytesIn,
        bytesOut: current.bytesOut - baseline.bytesOut,
      });
    }
    baseline = current;
  }
  return intervals;
}

export type IntervalClassification = IntervalKind | 'attributed' | 'known-quiet' | 'gap';

export interface ClassifiedInterval extends SampleInterval {
  /**
   * Measured intervals classify by span against 3x the sampling cadence:
   * zero delta is known-quiet, nonzero is a gap, sub-threshold attributes to
   * its END timestamp's local day. Discontinuities pass through under their
   * own kind (decision internet-spend 002).
   */
  readonly classification: IntervalClassification;
}

export function classifyIntervals(
  intervals: readonly SampleInterval[],
  options: { cadenceMs: number },
): ClassifiedInterval[] {
  const thresholdMs = options.cadenceMs * 3;
  return intervals.map((interval) => {
    let classification: IntervalClassification = interval.kind;
    if (interval.kind === 'measured') {
      const span = interval.end - interval.start;
      const zeroDelta = interval.bytesIn === 0 && interval.bytesOut === 0;
      if (span > thresholdMs) {
        classification = zeroDelta ? 'known-quiet' : 'gap';
      } else {
        classification = 'attributed';
      }
    }
    return { ...interval, classification };
  });
}

export interface CivilDate {
  /** Full year. */
  readonly year: number;
  /** 1-12. */
  readonly month: number;
  /** 1-31. */
  readonly day: number;
}

export interface DayBucket {
  /** Local calendar day, `YYYY-MM-DD`. */
  readonly date: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
  /** A hole day has no attributed bytes; it renders as not-known unless quiet evidence says otherwise. */
  readonly status: 'attributed' | 'hole';
  /** Intersected by a gap or a discontinuity span — rendered hatched. */
  readonly partial: boolean;
}

export interface HatchSpan {
  readonly start: number;
  readonly end: number;
}

export interface DayBucketing {
  readonly days: DayBucket[];
  /** Gap bytes count toward period totals but no day (decision internet-spend 002). */
  readonly unattributedBytesIn: number;
  readonly unattributedBytesOut: number;
  readonly hatches: HatchSpan[];
}

function civilDateString(date: CivilDate): string {
  const month = String(date.month).padStart(2, '0');
  const day = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

const DAY_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function civilDateInTimeZone(epochMs: number, timeZone: string): CivilDate {
  let formatter = DAY_PARTS_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DAY_PARTS_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`time zone formatter produced no ${type}`);
    return Number(part.value);
  };
  return { year: read('year'), month: read('month'), day: read('day') };
}

const OFFSET_PARTS_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function timeZoneOffsetMs(epochMs: number, timeZone: string): number {
  let formatter = OFFSET_PARTS_FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    OFFSET_PARTS_FORMATTERS.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(new Date(epochMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (!part) throw new Error(`time zone formatter produced no ${type}`);
    return Number(part.value);
  };
  const asUtc = Date.UTC(read('year'), read('month') - 1, read('day'), read('hour'), read('minute'), read('second'));
  return asUtc - epochMs;
}

/** UTC epoch of local midnight starting `date` in `timeZone`; two-pass so DST offsets settle. */
export function zonedDayStartUtc(date: CivilDate, timeZone: string): number {
  const guess = Date.UTC(date.year, date.month - 1, date.day);
  let result = guess - timeZoneOffsetMs(guess, timeZone);
  result = guess - timeZoneOffsetMs(result, timeZone);
  return result;
}

function compareCivil(a: CivilDate, b: CivilDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * Local-time day bucketing of attributed deltas over UTC epochs (decision
 * internet-spend 003, adopting the ADR 0030 split). Attributed intervals land
 * on their END timestamp's local day; gap bytes stay unattributed while every
 * intersecting local day goes partial; discontinuities hatch without bytes.
 * Every calendar day in the covered range gets a row, holes included.
 *
 * Invariant: sum(daily attributed) + unattributed equals the sum of valid
 * deltas — nothing interpolated or split (decision internet-spend 002).
 */
export function bucketDays(intervals: readonly ClassifiedInterval[], options: { timeZone: string }): DayBucketing {
  const timeZone = options.timeZone;
  const attributed = new Map<string, { bytesIn: number; bytesOut: number }>();
  const partialDays = new Set<string>();
  const hatches: HatchSpan[] = [];
  let unattributedBytesIn = 0;
  let unattributedBytesOut = 0;

  let rangeStart = Number.POSITIVE_INFINITY;
  let rangeEnd = Number.NEGATIVE_INFINITY;

  for (const interval of intervals) {
    if (Number.isFinite(interval.start)) rangeStart = Math.min(rangeStart, interval.start);
    if (Number.isFinite(interval.end)) rangeEnd = Math.max(rangeEnd, interval.end);

    if (interval.classification === 'attributed') {
      const date = civilDateString(civilDateInTimeZone(interval.end, timeZone));
      const bucket = attributed.get(date) ?? { bytesIn: 0, bytesOut: 0 };
      bucket.bytesIn += interval.bytesIn;
      bucket.bytesOut += interval.bytesOut;
      attributed.set(date, bucket);
      continue;
    }

    if (interval.classification === 'gap') {
      unattributedBytesIn += interval.bytesIn;
      unattributedBytesOut += interval.bytesOut;
    }

    // Gaps and discontinuities both hatch across [start, end) and mark every
    // intersecting local day partial (decision internet-spend 002).
    if (interval.classification !== 'known-quiet') {
      hatches.push({ start: interval.start, end: interval.end });
      const firstDay = civilDateInTimeZone(Math.max(interval.start, 0), timeZone);
      const lastDay = civilDateInTimeZone(Math.max(interval.end - 1, 0), timeZone);
      for (let day = firstDay; compareCivil(day, lastDay) <= 0; day = addCivilDays(day, 1)) {
        partialDays.add(civilDateString(day));
      }
    }
  }

  const days: DayBucket[] = [];
  if (Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart) {
    let cursor = civilDateInTimeZone(rangeStart, timeZone);
    const lastDate = civilDateInTimeZone(rangeEnd - 1, timeZone);
    while (compareCivil(cursor, lastDate) <= 0) {
      const date = civilDateString(cursor);
      const bucket = attributed.get(date);
      days.push({
        date,
        bytesIn: bucket?.bytesIn ?? 0,
        bytesOut: bucket?.bytesOut ?? 0,
        status: bucket ? 'attributed' : 'hole',
        partial: partialDays.has(date),
      });
      cursor = addCivilDays(cursor, 1);
    }
  }

  return {
    days,
    unattributedBytesIn,
    unattributedBytesOut,
    hatches,
  };
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function clampedReset(year: number, month: number, resetDay: number): CivilDate {
  return { year, month, day: Math.min(resetDay, daysInMonth(year, month)) };
}

function nextMonthOf(date: CivilDate): CivilDate {
  return date.month === 12
    ? { year: date.year + 1, month: 1, day: 1 }
    : { year: date.year, month: date.month + 1, day: 1 };
}

function previousMonthOf(date: CivilDate): CivilDate {
  return date.month === 1
    ? { year: date.year - 1, month: 12, day: 1 }
    : { year: date.year, month: date.month - 1, day: 1 };
}

/**
 * Anchored day-of-month reset clamped to the month's last day; resetDay 1 is
 * the calendar month; unset falls back to the 1st (decision internet-spend
 * 003). Purely civil-date arithmetic, so DST cannot move a boundary.
 */
export function periodBounds(
  nowLocal: CivilDate,
  resetDay: number | null | undefined,
): { start: CivilDate; endExclusive: CivilDate } {
  const anchor = resetDay ?? 1;
  const currentReset = clampedReset(nowLocal.year, nowLocal.month, anchor);
  if (compareCivil(nowLocal, currentReset) >= 0) {
    const nextMonth = nextMonthOf(nowLocal);
    return { start: currentReset, endExclusive: clampedReset(nextMonth.year, nextMonth.month, anchor) };
  }
  const previousMonth = previousMonthOf(nowLocal);
  return {
    start: clampedReset(previousMonth.year, previousMonth.month, anchor),
    endExclusive: currentReset,
  };
}

/**
 * nettop reports process names as `name.pid` (`launchd.1`); the suffix is
 * stripped before matching (decision internet-spend 004).
 */
export function stripPidSuffix(name: string): string {
  return /\.\d+$/.test(name) ? name.slice(0, name.lastIndexOf('.')) : name;
}

/** The scope's default list verbatim — redundant entries kept because the scope wrote them (decision internet-spend 004). */
export const DEFAULT_AGENT_PATTERNS: readonly string[] = ['node', 'claude', 'Claude', 'codex', 'ox'];

/**
 * Case-insensitive substring match on the process name after `.pid` stripping
 * (decision internet-spend 004).
 */
export function classifyAgents(name: string, patterns: readonly string[] = DEFAULT_AGENT_PATTERNS): boolean {
  const stripped = stripPidSuffix(name).toLowerCase();
  return patterns.some((pattern) => stripped.includes(pattern.toLowerCase()));
}

export const DEFAULT_INTERFACE_PATTERN = 'en*';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*` wildcard match against an interface name (`en*` keeps en0, drops utun0). */
export function matchesInterfacePattern(iface: string, pattern: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(iface);
}

/**
 * Read-time interface-set selection over stored per-(process, interface) rows
 * (decision internet-spend 001). Loopback never reaches here — the collector
 * stores non-loopback interfaces only — and the default wire-byte filter is
 * `en*`.
 */
export function filterInterfaces<Row extends { readonly interface: string }>(
  rows: readonly Row[],
  pattern: string = DEFAULT_INTERFACE_PATTERN,
): Row[] {
  return rows.filter((row) => matchesInterfacePattern(row.interface, pattern));
}
