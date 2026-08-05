import { describe, expect, it } from 'vitest';
import { baselineRate, costRatePoints, summarizeCostRate } from '../src/cost-rate.js';
import { costPerMTok, rateTokens, type UsageDigest } from '../src/digest.js';

interface DayShape {
  /** Fresh (non-cached) input tokens. */
  input?: number;
  cacheRead?: number;
  output?: number;
  cost: number;
}

/** A digest carrying only the fields a rate is computed from; the rest is inert. */
function digest(date: string, { input = 0, cacheRead = 0, output = 0, cost }: DayShape): UsageDigest {
  const realInput = input + cacheRead;
  return {
    date,
    requestCount: 1,
    skipped: 0,
    cacheBreakpointInjections: 0,
    cacheBreakpointObservations: 0,
    cacheBreakpointDeclines: {},
    models: {},
    tokens: {
      input,
      output,
      cacheRead,
      cacheCreation: 0,
      realInput,
      cacheHitRatio: realInput > 0 ? cacheRead / realInput : 0,
    },
    cost: { input: cost, output: 0, cacheWrite: 0, cacheRead: 0, total: cost },
    topTools: [],
    avgSystemPromptBytes: 0,
    toolOverheadPctOfInput: 0,
    busiestHour: null,
    perCall: { work: NO_CALLS, classifier: NO_CALLS, all: NO_CALLS, identified: false },
  };
}

/** Per-call stats are inert here — a rate is computed from day totals. */
const NO_CALLS = {
  requests: 0,
  sessions: 0,
  costUsd: 0,
  costTotal: 0,
  fixedPrefixTokens: 0,
  freshInputTokens: 0,
  callsPerSession: 0,
};

describe('costPerMTok', () => {
  it('prices the whole prompt plus the output, not just the fresh tokens', () => {
    const d = digest('2026-08-01', { input: 1_500_000, output: 500_000, cost: 4 });
    expect(rateTokens(d)).toBe(2_000_000);
    expect(costPerMTok(d)).toBe(2);
  });

  it('is zero on a day that moved no tokens, rather than dividing by zero', () => {
    expect(costPerMTok(digest('2026-08-01', { cost: 0 }))).toBe(0);
  });

  it('falls when the same volume is served from cache — the point of the metric', () => {
    // Both days move 10.2M tokens. On opus list prices a cache read is $1.50/MTok
    // against $15 for fresh input, so only the token *mix* separates them.
    const cached = digest('2026-08-01', { cacheRead: 10_000_000, output: 200_000, cost: 10 * 1.5 + 0.2 * 75 });
    const fresh = digest('2026-08-02', { input: 10_000_000, output: 200_000, cost: 10 * 15 + 0.2 * 75 });

    expect(rateTokens(cached)).toBe(rateTokens(fresh));
    expect(costPerMTok(cached)).toBeLessThan(costPerMTok(fresh));
  });
});

describe('costRatePoints', () => {
  it('drops a day that moved no tokens instead of plotting it at the origin', () => {
    const days = [
      digest('2026-08-01', { input: 1_000_000, cost: 3 }),
      digest('2026-08-02', { cost: 0 }),
      digest('2026-08-03', { input: 2_000_000, cost: 6 }),
    ];
    expect(costRatePoints(days).map((p) => p.date)).toEqual(['2026-08-01', '2026-08-03']);
  });
});

describe('baselineRate', () => {
  it('excludes the newest day, so today cannot move the bar it is judged against', () => {
    const days = [
      digest('2026-08-01', { input: 1_000_000, cost: 2 }),
      digest('2026-08-02', { input: 1_000_000, cost: 4 }),
      digest('2026-08-03', { input: 1_000_000, cost: 6 }),
      // An extravagant today would drag a mean, and be the median of all four.
      digest('2026-08-04', { input: 1_000_000, cost: 100 }),
    ];
    expect(baselineRate(days)).toBe(4);
  });

  it('averages the middle two when the prior days are even in number', () => {
    const days = [
      digest('2026-08-01', { input: 1_000_000, cost: 1 }),
      digest('2026-08-02', { input: 1_000_000, cost: 2 }),
      digest('2026-08-03', { input: 1_000_000, cost: 4 }),
      digest('2026-08-04', { input: 1_000_000, cost: 8 }),
      digest('2026-08-05', { input: 1_000_000, cost: 99 }),
    ];
    expect(baselineRate(days)).toBe(3);
  });

  it('is null on a first day of capture, with nothing earlier to compare against', () => {
    expect(baselineRate([digest('2026-08-01', { input: 1_000_000, cost: 3 })])).toBeNull();
    expect(baselineRate([])).toBeNull();
  });
});

describe('summarizeCostRate', () => {
  it('reports today as cheaper than the baseline with a negative delta', () => {
    const days = [
      digest('2026-08-01', { input: 1_000_000, cost: 4 }),
      digest('2026-08-02', { input: 1_000_000, cost: 4 }),
      digest('2026-08-03', { input: 500_000, cost: 1.5 }),
    ];
    const summary = summarizeCostRate(days);
    expect(summary.baseline).toBe(4);
    expect(summary.today?.rate).toBe(3);
    expect(summary.deltaPct).toBe(-25);
  });

  it('compares on rate, not on spend — a bigger day can still be the cheaper one', () => {
    const days = [
      digest('2026-08-01', { input: 1_000_000, cost: 5 }),
      // Four times the volume and four times the spend of the day before, at a
      // lower price per token.
      digest('2026-08-02', { input: 4_000_000, cost: 16 }),
    ];
    const summary = summarizeCostRate(days);
    expect(summary.today?.cost).toBeGreaterThan(5);
    expect(summary.deltaPct).toBe(-20);
  });

  it('has no delta when nothing earlier moved tokens', () => {
    const summary = summarizeCostRate([digest('2026-08-01', { input: 1_000_000, cost: 3 })]);
    expect(summary.today?.rate).toBe(3);
    expect(summary.baseline).toBeNull();
    expect(summary.deltaPct).toBeNull();
  });

  it('has no today when the newest day has not moved a token yet', () => {
    const days = [digest('2026-08-01', { input: 1_000_000, cost: 3 }), digest('2026-08-02', { cost: 0 })];
    const summary = summarizeCostRate(days);
    expect(summary.today).toBeNull();
    expect(summary.baseline).toBe(3);
    expect(summary.deltaPct).toBeNull();
  });
});
