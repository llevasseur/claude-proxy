import { describe, expect, it } from 'vitest';
import { computeDigest, digestsByDay, type UsageDigest } from '../src/digest.js';
import { makeSidecar } from './helpers.js';

describe('computeDigest', () => {
  it('returns a well-formed empty digest for no input', () => {
    const d = computeDigest([], { date: '2026-07-15' });
    expect(d.requestCount).toBe(0);
    expect(d.skipped).toBe(0);
    expect(d.tokens.realInput).toBe(0);
    expect(d.tokens.cacheHitRatio).toBe(0);
    expect(d.cost.total).toBe(0);
    expect(d.topTools).toEqual([]);
    expect(d.busiestHour).toBeNull();
    expect(d.avgSystemPromptBytes).toBe(0);
  });

  it('aggregates a single request', () => {
    const d = computeDigest([makeSidecar()], { date: '2026-07-15' });
    expect(d.requestCount).toBe(1);
    expect(d.tokens.realInput).toBe(9_100);
    expect(d.tokens.cacheHitRatio).toBeCloseTo(8_000 / 9_100);
    expect(d.cost.total).toBeGreaterThan(0);
    expect(d.models).toEqual({ 'claude-opus-4-8': 1 });
    expect(d.topTools[0]!.name).toBe('Workflow');
    // 13:47Z is 09:47 Eastern.
    expect(d.busiestHour).toEqual({ hour: 9, requestCount: 1 });
  });

  it('counts multiple models and sums cost', () => {
    const d = computeDigest([makeSidecar({ model: 'claude-opus-4-8' }), makeSidecar({ model: 'claude-haiku-4-5' })], {
      date: '2026-07-15',
    });
    expect(d.requestCount).toBe(2);
    expect(d.models).toEqual({ 'claude-opus-4-8': 1, 'claude-haiku-4-5': 1 });
    const single = computeDigest([makeSidecar({ model: 'claude-opus-4-8' })], { date: 'x' });
    expect(d.cost.total).toBeGreaterThan(single.cost.total);
  });

  it('skips malformed sidecars but keeps valid ones', () => {
    const d = computeDigest([makeSidecar(), { nope: true }, null, 'garbage'], { date: '2026-07-15' });
    expect(d.requestCount).toBe(1);
    expect(d.skipped).toBe(3);
  });

  it('ranks tools by total bytes and computes share', () => {
    const s = makeSidecar({
      tools: [
        { name: 'Big', bytes: 30_000, estTokens: 7_500 },
        { name: 'Small', bytes: 10_000, estTokens: 2_500 },
      ],
    });
    const d = computeDigest([s], { date: '2026-07-15' });
    expect(d.topTools.map((t) => t.name)).toEqual(['Big', 'Small']);
    expect(d.topTools[0]!.pctOfToolBytes).toBeCloseTo(75);
  });

  it('computes a day-over-day trend against a prior digest', () => {
    const prior: UsageDigest = computeDigest([makeSidecar()], { date: '2026-07-14' });
    const today = computeDigest([makeSidecar(), makeSidecar()], { date: '2026-07-15', priorDigest: prior });
    expect(today.trend).toBeDefined();
    const reqTrend = today.trend!.find((t) => t.field === 'requestCount')!;
    expect(reqTrend.today).toBe(2);
    expect(reqTrend.prior).toBe(1);
    expect(reqTrend.deltaPct).toBeCloseTo(100);
    expect(reqTrend.priorDate).toBe('2026-07-14');
  });

  it('trends against the last day that recorded traffic, not an idle one', () => {
    const busy = computeDigest([makeSidecar()], { date: '2026-07-13' });
    const idle = computeDigest([], { date: '2026-07-14' });
    const today = computeDigest([makeSidecar(), makeSidecar()], {
      date: '2026-07-15',
      priorDigests: [busy, idle],
    });
    const reqTrend = today.trend!.find((t) => t.field === 'requestCount')!;
    // Against the idle day this would have been 0%, on a day that doubled the
    // traffic of the last one that had any.
    expect(reqTrend.priorDate).toBe('2026-07-13');
    expect(reqTrend.prior).toBe(1);
    expect(reqTrend.deltaPct).toBeCloseTo(100);
  });

  it('leaves a field flat and undated when nothing earlier recorded it', () => {
    const idle = computeDigest([], { date: '2026-07-14' });
    const today = computeDigest([makeSidecar()], { date: '2026-07-15', priorDigests: [idle] });
    const reqTrend = today.trend!.find((t) => t.field === 'requestCount')!;
    expect(reqTrend.priorDate).toBeUndefined();
    expect(reqTrend.prior).toBe(0);
    expect(reqTrend.deltaPct).toBe(0);
  });

  it('trends the two ratio fields in percentage points, as their cards report them', () => {
    const day = (cacheRead: number, realInput: number) =>
      makeSidecar({ tokens: { input: realInput - cacheRead, output: 500, cacheRead, cacheCreation: 0, realInput } });
    // 50% of the prompt cached, and 6,000 tool tokens against 10,000 input.
    const prior = computeDigest([day(5_000, 10_000)], { date: '2026-07-14' });
    // 90% cached, and the same tool schemas against twice the input.
    const today = computeDigest([day(18_000, 20_000)], { date: '2026-07-15', priorDigest: prior });

    const cache = today.trend!.find((t) => t.field === 'cacheHitPct')!;
    expect(cache.today).toBeCloseTo(90);
    expect(cache.prior).toBeCloseTo(50);
    expect(cache.deltaPct).toBeCloseTo(80);
    expect(cache.priorDate).toBe('2026-07-14');

    const overhead = today.trend!.find((t) => t.field === 'toolOverheadPct')!;
    expect(overhead.today).toBeCloseTo(30);
    expect(overhead.prior).toBeCloseTo(60);
    expect(overhead.deltaPct).toBeCloseTo(-50);
    expect(overhead.priorDate).toBe('2026-07-14');
  });

  it('finds the busiest hour, in the reporting zone', () => {
    const at = (h: string) => makeSidecar({ timestamp: `2026-07-15T${h}:00:00.000Z` });
    const d = computeDigest([at('09'), at('14'), at('14')], { date: '2026-07-15' });
    // 14:00Z is 10:00 Eastern.
    expect(d.busiestHour).toEqual({ hour: 10, requestCount: 2 });
  });
});

describe('digestsByDay', () => {
  it('keeps a late-evening request on the reporting day it was made', () => {
    // 01:30Z on the 16th is 21:30 Eastern on the 15th.
    const evening = makeSidecar({ timestamp: '2026-07-16T01:30:00.000Z' });
    const morning = makeSidecar({ timestamp: '2026-07-15T14:00:00.000Z' });
    const digests = digestsByDay([evening, morning]);
    expect(digests.map((d) => d.date)).toEqual(['2026-07-15']);
    expect(digests[0]!.requestCount).toBe(2);
  });

  it('splits by reporting-zone day and chains trend across days', () => {
    const day1 = makeSidecar({ timestamp: '2026-07-14T10:00:00.000Z' });
    const day2a = makeSidecar({ timestamp: '2026-07-15T10:00:00.000Z' });
    const day2b = makeSidecar({ timestamp: '2026-07-15T11:00:00.000Z' });
    const digests = digestsByDay([day2b, day1, day2a]);
    expect(digests.map((d) => d.date)).toEqual(['2026-07-14', '2026-07-15']);
    expect(digests[0]!.trend).toBeUndefined();
    expect(digests[1]!.trend).toBeDefined();
    expect(digests[1]!.requestCount).toBe(2);
  });
});
