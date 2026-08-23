import { describe, expect, test } from 'vitest';
import { CACHED_INPUT_METERING_WEIGHT, computeUsageWindows, type UsageWindowMeter } from '../src/limits.ts';
import type { UsageTotals } from '../src/types.ts';

function usage(overrides: Partial<UsageTotals> = {}): UsageTotals {
  const inputTokens = overrides.inputTokens ?? 0;
  const cachedInputTokens = overrides.cachedInputTokens ?? 0;
  const outputTokens = overrides.outputTokens ?? 0;
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: overrides.reasoningOutputTokens ?? 0,
    totalTokens: inputTokens + outputTokens,
  };
}

function record(timestamp: string, totals: UsageTotals) {
  return { timestamp, usage: totals };
}

const NOW = new Date('2026-08-20T18:00:00.000Z');

describe('usage window meters', () => {
  test('cached input meters at the catalogue discount, not full price', () => {
    expect(CACHED_INPUT_METERING_WEIGHT).toBe(0.1);
    const windows = computeUsageWindows(
      [record('2026-08-20T17:00:00.000Z', usage({ inputTokens: 100, cachedInputTokens: 40, outputTokens: 50 }))],
      { '5h': 1000 },
      NOW,
    );
    // 60 fresh * 1 + 40 cached * 0.1 + 50 out * 1 = 114 units.
    expect(windows[0]?.usedUnits).toBe('114.0');
    expect(windows[0]?.utilization).toBeCloseTo(0.114, 6);
  });

  test('windows only count records inside their span and omit unconfigured kinds', () => {
    const records = [
      record('2026-08-20T12:59:59.000Z', usage({ inputTokens: 10, outputTokens: 5 })),
      record('2026-08-20T13:00:00.000Z', usage({ inputTokens: 20, outputTokens: 5 })),
      record('2026-08-20T17:59:59.999Z', usage({ inputTokens: 30 })),
      record('2026-08-20T18:00:00.000Z', usage({ inputTokens: 999 })), // at the boundary: excluded
      record('2026-08-13T18:00:01.000Z', usage({ inputTokens: 70 })), // inside the week only
    ];
    const [fiveHour, week] = computeUsageWindows(records, { '5h': 100, week: 500 }, NOW) as [
      UsageWindowMeter,
      UsageWindowMeter,
    ];
    expect(fiveHour.kind).toBe('5h');
    expect(fiveHour.requests).toBe(2);
    expect(fiveHour.usedUnits).toBe('55.0');
    expect(fiveHour.windowStartInclusive).toBe('2026-08-20T13:00:00.000Z');
    expect(week.requests).toBe(4);
    expect(week.usedUnits).toBe('140.0');

    // No ceilings configured: nothing is shown against an invented denominator.
    expect(computeUsageWindows(records, {}, NOW)).toEqual([]);
  });

  test('a zero ceiling reports utilization null instead of dividing by zero', () => {
    const [meter] = computeUsageWindows(
      [record('2026-08-20T17:00:00.000Z', usage({ inputTokens: 5 }))],
      { '5h': 0 },
      NOW,
    );
    expect(meter?.ceilingUnits).toBe('0.0');
    expect(meter?.utilization).toBeNull();
  });
});
