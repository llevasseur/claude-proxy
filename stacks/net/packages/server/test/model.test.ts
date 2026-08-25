import { describe, expect, it } from 'vitest';
import type { ClassifiedInterval, NetSample } from '../src/model.ts';
import { bucketDays, type CivilDate, classifyIntervals, computeDeltas, zonedDayStartUtc } from '../src/model.ts';

const HOUR = 3_600_000;

function sample(overrides: Partial<NetSample> & Pick<NetSample, 'timestamp'>): NetSample {
  return {
    bootEpoch: 100,
    name: 'node',
    pid: 1,
    interface: 'en0',
    bytesIn: 0,
    bytesOut: 0,
    ...overrides,
  };
}

describe('computeDeltas (decision internet-spend 002)', () => {
  it('baselines the first sample without emitting bytes or a verdict', () => {
    const intervals = computeDeltas([sample({ timestamp: 0, bytesIn: 5_000 })]);
    expect(intervals).toEqual([]);
  });

  it('yields a delta for consecutive samples with new >= old', () => {
    const intervals = computeDeltas([
      sample({ timestamp: 0, bytesIn: 1_000, bytesOut: 100 }),
      sample({ timestamp: HOUR, bytesIn: 3_000, bytesOut: 400 }),
    ]);
    expect(intervals).toEqual([{ start: 0, end: HOUR, kind: 'measured', bytesIn: 2_000, bytesOut: 300 }]);
  });

  it('emits a zero-byte decrease discontinuity when the counter drops (pid reuse)', () => {
    const intervals = computeDeltas([
      sample({ timestamp: 0, pid: 7, bytesIn: 10_000 }),
      sample({ timestamp: HOUR, pid: 7, bytesIn: 20_000 }),
      // pid 7 is reused by another process; counters reset below the previous value
      sample({ timestamp: 2 * HOUR, pid: 7, bytesIn: 500 }),
    ]);
    expect(intervals[1]).toEqual({ start: HOUR, end: 2 * HOUR, kind: 'decrease', bytesIn: 0, bytesOut: 0 });
  });

  it('gives a boot change precedence over a decrease and re-baselines after it', () => {
    const intervals = computeDeltas([
      sample({ timestamp: 0, bootEpoch: 100, bytesIn: 50_000 }),
      // reboot: new boot AND lower counters — must read as boot, not decrease
      sample({ timestamp: HOUR, bootEpoch: 200, bytesIn: 300 }),
      sample({ timestamp: 2 * HOUR, bootEpoch: 200, bytesIn: 1_300 }),
    ]);
    expect(intervals).toEqual([
      { start: 0, end: HOUR, kind: 'boot', bytesIn: 0, bytesOut: 0 },
      { start: HOUR, end: 2 * HOUR, kind: 'measured', bytesIn: 1_000, bytesOut: 0 },
    ]);
  });
});

describe('classifyIntervals (decision internet-spend 002 gap semantics)', () => {
  const CADENCE_MS = HOUR;

  function classified(kind: 'measured', start: number, end: number, bytesIn: number, bytesOut = 0) {
    return classifyIntervals([{ start, end, kind, bytesIn, bytesOut }], { cadenceMs: CADENCE_MS });
  }

  it('marks a sub-threshold interval attributed', () => {
    expect(classified('measured', 0, 2 * HOUR, 500)[0]?.classification).toBe('attributed');
  });

  it('treats exactly 3x cadence as sub-threshold — only strictly greater spans are holes', () => {
    expect(classified('measured', 0, 3 * HOUR + 1, 500)[0]?.classification).toBe('gap');
    expect(classified('measured', 0, 3 * HOUR, 500)[0]?.classification).toBe('attributed');
  });

  it('marks a long zero-delta span known-quiet — an overnight sleep renders flat, not holed', () => {
    expect(classified('measured', 0, 9 * HOUR, 0)[0]?.classification).toBe('known-quiet');
  });

  it('marks a long nonzero-delta span as a gap', () => {
    expect(classified('measured', 0, 9 * HOUR, 40_000)[0]?.classification).toBe('gap');
  });

  it('passes discontinuities through under their own kind regardless of span', () => {
    const intervals = classifyIntervals(
      [
        { start: 0, end: 30 * HOUR, kind: 'boot', bytesIn: 0, bytesOut: 0 },
        { start: 0, end: 30 * HOUR, kind: 'decrease', bytesIn: 0, bytesOut: 0 },
      ],
      { cadenceMs: CADENCE_MS },
    );
    expect(intervals.map((interval) => interval.classification)).toEqual(['boot', 'decrease']);
  });
});

describe('zonedDayStartUtc across DST transitions', () => {
  it('yields a 23-hour spring-forward day in America/New_York', () => {
    expect(dayStart(2026, 3, 9) - dayStart(2026, 3, 8)).toBe(23 * HOUR);
  });

  it('yields a 25-hour fall-back day in America/New_York', () => {
    expect(dayStart(2026, 11, 2) - dayStart(2026, 11, 1)).toBe(25 * HOUR);
  });
});

const TZ = 'America/New_York';

function dayStart(year: number, month: number, day: number): number {
  return zonedDayStartUtc({ year, month, day } satisfies CivilDate, TZ);
}

function attributed(start: number, end: number, bytesIn: number): ClassifiedInterval {
  return { start, end, kind: 'measured', bytesIn, bytesOut: 0, classification: 'attributed' };
}

function gap(start: number, end: number, bytesIn: number): ClassifiedInterval {
  return { start, end, kind: 'measured', bytesIn, bytesOut: 0, classification: 'gap' };
}

describe('bucketDays (decision internet-spend 003 local-time bucketing over UTC epochs)', () => {
  it('attributes to the END timestamp local day across the UTC midnight line', () => {
    // 2026-03-08T02:30Z is 21:30 on 2026-03-07 in New York (EST)
    const days = bucketDays([attributed(Date.parse('2026-03-07T20:00:00Z'), Date.parse('2026-03-08T02:30:00Z'), 700)], {
      timeZone: TZ,
    });
    const withBytes = days.days.filter((day) => day.bytesIn > 0);
    expect(withBytes).toHaveLength(1);
    expect(withBytes[0]).toMatchObject({ date: '2026-03-07', bytesIn: 700, status: 'attributed' });
  });

  it('emits one row per calendar day including hole days marked not-known', () => {
    // Attributed samples only on Mar 8 and Mar 10; Mar 9 has no attribution at all.
    const days = bucketDays(
      [
        attributed(dayStart(2026, 3, 8) + 3 * HOUR, dayStart(2026, 3, 8) + 4 * HOUR, 100),
        attributed(dayStart(2026, 3, 10) + 5 * HOUR, dayStart(2026, 3, 10) + 6 * HOUR, 200),
      ],
      { timeZone: TZ },
    );
    expect(days.days.map((day) => [day.date, day.status])).toEqual([
      ['2026-03-08', 'attributed'],
      ['2026-03-09', 'hole'],
      ['2026-03-10', 'attributed'],
    ]);
  });

  it('keeps gap bytes unattributed, hatches their span, and marks every intersecting day partial', () => {
    // Gap spanning Mar 9 late into Mar 11 early.
    const gapStart = dayStart(2026, 3, 9) + 22 * HOUR;
    const gapEnd = dayStart(2026, 3, 11) + 2 * HOUR;
    const result = bucketDays([gap(gapStart, gapEnd, 9_000)], { timeZone: TZ });
    expect(result.unattributedBytesIn).toBe(9_000);
    expect(result.unattributedBytesOut).toBe(0);
    expect(result.hatches).toEqual([{ start: gapStart, end: gapEnd }]);
    const partial = result.days.filter((day) => day.partial);
    expect(partial.map((day) => day.date)).toEqual(['2026-03-09', '2026-03-10', '2026-03-11']);
    // Gap bytes belong to no daily bar.
    for (const day of result.days) {
      expect(day.bytesIn).toBe(0);
      expect(day.status).toBe('hole');
    }
  });

  it('renders a discontinuity as hatch and partial without any bytes', () => {
    const start = dayStart(2026, 3, 8) + 1 * HOUR;
    const end = start + 30 * 60_000;
    const result = bucketDays([{ start, end, kind: 'decrease', bytesIn: 0, bytesOut: 0, classification: 'decrease' }], {
      timeZone: TZ,
    });
    expect(result.hatches).toHaveLength(1);
    expect(result.days[0]).toMatchObject({ date: '2026-03-08', partial: true, bytesIn: 0 });
    expect(result.unattributedBytesIn).toBe(0);
  });

  it('never counts a known-quiet span as evidence of anything', () => {
    const start = dayStart(2026, 3, 8);
    const end = start + 9 * HOUR;
    const result = bucketDays(
      [{ start, end, kind: 'measured', bytesIn: 0, bytesOut: 0, classification: 'known-quiet' }],
      { timeZone: TZ },
    );
    expect(result.hatches).toEqual([]);
    expect(result.days[0]).toMatchObject({ date: '2026-03-08', status: 'hole', partial: false });
  });

  it('holds the invariant: attributed + unattributed equals the sum of valid deltas', () => {
    const intervals: ClassifiedInterval[] = [
      attributed(dayStart(2026, 3, 8) + 2 * HOUR, dayStart(2026, 3, 8) + 3 * HOUR, 1_000),
      attributed(dayStart(2026, 3, 9) + 4 * HOUR, dayStart(2026, 3, 9) + 5 * HOUR, 2_500),
      gap(dayStart(2026, 3, 9) + 20 * HOUR, dayStart(2026, 3, 10) + 4 * HOUR, 7_500),
      { start: 0, end: HOUR, kind: 'decrease', bytesIn: 0, bytesOut: 0, classification: 'decrease' },
    ];
    const validDeltaTotal = 1_000 + 2_500 + 7_500;
    const result = bucketDays(intervals, { timeZone: TZ });
    const attributedTotal = result.days.reduce((sum, day) => sum + day.bytesIn, 0);
    expect(attributedTotal + result.unattributedBytesIn).toBe(validDeltaTotal);
  });

  it('returns empty output for an empty corpus', () => {
    expect(bucketDays([], { timeZone: TZ })).toEqual({
      days: [],
      unattributedBytesIn: 0,
      unattributedBytesOut: 0,
      hatches: [],
    });
  });
});
