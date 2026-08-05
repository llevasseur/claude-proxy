import { describe, expect, it } from 'vitest';
import { ADVICE_STEADY_PCT, ADVICE_THRESHOLDS, adviceMovement, HeuristicAdviceProvider } from '../src/advice.js';
import { computeDigest } from '../src/digest.js';
import { makeSidecar } from './helpers.js';

const provider = new HeuristicAdviceProvider();
const ids = (digestInput: Parameters<typeof computeDigest>[0], date = '2026-07-15') =>
  provider.advise(computeDigest(digestInput, { date })).map((a) => a.id);

describe('HeuristicAdviceProvider', () => {
  it('reports no activity on an empty day', () => {
    expect(ids([])).toEqual(['no-activity']);
  });

  it('flags a dominant tool', () => {
    const s = makeSidecar({
      tools: [
        { name: 'Hog', bytes: 90_000, estTokens: 22_500 },
        { name: 'Tiny', bytes: 1_000, estTokens: 250 },
      ],
    });
    expect(ids([s])).toContain('dominant-tool');
  });

  it('flags high tool overhead relative to input', () => {
    // Huge tool tokens vs tiny real input → overhead % well over threshold.
    const s = makeSidecar({
      tokens: { input: 10, output: 10, cacheRead: 90, cacheCreation: 0, realInput: 100 },
      tools: [{ name: 'Big', bytes: 400_000, estTokens: 100_000 }],
    });
    expect(ids([s])).toContain('tool-overhead');
  });

  it('flags low cache-hit ratio only with enough traffic', () => {
    const lowCache = makeSidecar({
      tokens: { input: 900, output: 100, cacheRead: 100, cacheCreation: 0, realInput: 1_000 },
      tools: [{ name: 'A', bytes: 10, estTokens: 2 }],
    });
    const many = Array.from({ length: ADVICE_THRESHOLDS.minRequestsForCacheAdvice }, () => lowCache);
    expect(ids(many)).toContain('low-cache-hit');
    // A single request (below the traffic floor) should not trip it.
    expect(ids([lowCache])).not.toContain('low-cache-hit');
  });

  it('flags a high estimated daily cost as high severity', () => {
    // Lots of opus output → well over the cost threshold.
    const pricey = makeSidecar({
      tokens: { input: 0, output: 2_000_000, cacheRead: 0, cacheCreation: 0, realInput: 0 },
      tools: [{ name: 'A', bytes: 10, estTokens: 2 }],
    });
    const advice = provider.advise(computeDigest([pricey], { date: '2026-07-15' }));
    const high = advice.find((a) => a.id === 'high-cost');
    expect(high?.severity).toBe('high');
    // High severity sorts first.
    expect(advice[0]!.severity).toBe('high');
  });

  it('returns a healthy note when nothing trips', () => {
    // Many small, evenly-sized tools → no single tool dominates (<15%),
    // low overhead, high cache hit, small system prompt: nothing trips.
    const tools = Array.from({ length: 8 }, (_, i) => ({ name: `T${i}`, bytes: 20, estTokens: 2 }));
    const clean = makeSidecar({
      tokens: { input: 10, output: 10, cacheRead: 980, cacheCreation: 0, realInput: 1_000 },
      request: { toolCount: tools.length, toolsBytes: 160, systemBytes: 500, totalBytes: 5_000 },
      tools,
    });
    expect(ids([clean])).toEqual(['healthy']);
  });
});

describe('adviceMovement', () => {
  /** A day whose system prompt averages `systemBytes` — what `large-system-prompt` reads. */
  const dayOfPrompt = (systemBytes: number, date: string) =>
    computeDigest(
      [
        makeSidecar({
          request: { toolCount: 1, toolsBytes: 10, systemBytes, totalBytes: systemBytes + 1_000 },
          tools: [{ name: 'A', bytes: 10, estTokens: 2 }],
        }),
      ],
      { date },
    );

  it('calls a card steady when its metric barely moved since the prior day', () => {
    const today = dayOfPrompt(40_000, '2026-07-15');
    const prior = dayOfPrompt(40_500, '2026-07-14');
    const advice = provider.advise(today);

    const prompt = adviceMovement(advice, today, prior).find((m) => m.id === 'large-system-prompt');
    expect(prompt?.steady).toBe(true);
    // The date is what the collapsed summary line names.
    expect(prompt?.since).toBe('2026-07-14');
    expect(prompt?.change).toBeLessThan(ADVICE_STEADY_PCT);
  });

  it('leaves a card that moved materially in full', () => {
    const today = dayOfPrompt(40_000, '2026-07-15');
    const advice = provider.advise(today);

    const prompt = adviceMovement(advice, today, dayOfPrompt(20_000, '2026-07-14')).find(
      (m) => m.id === 'large-system-prompt',
    );
    expect(prompt?.steady).toBe(false);
    expect(prompt?.change).toBeCloseTo(1);
  });

  it('never calls a card steady on absent evidence', () => {
    const today = dayOfPrompt(40_000, '2026-07-15');
    const advice = provider.advise(today);

    // No prior day at all: nothing to compare, so the card renders rather than folding.
    for (const m of adviceMovement(advice, today, null)) {
      expect(m.steady).toBe(false);
      expect(m.since).toBeNull();
    }

    // A rule declaring no metric is not comparable either — `healthy` carries none.
    const clean = computeDigest(
      [
        makeSidecar({
          tokens: { input: 10, output: 10, cacheRead: 980, cacheCreation: 0, realInput: 1_000 },
          request: { toolCount: 8, toolsBytes: 160, systemBytes: 500, totalBytes: 5_000 },
          tools: Array.from({ length: 8 }, (_, i) => ({ name: `T${i}`, bytes: 20, estTokens: 2 })),
        }),
      ],
      { date: '2026-07-15' },
    );
    const healthy = adviceMovement(provider.advise(clean), clean, clean);
    expect(healthy).toEqual([
      { id: 'healthy', metric: null, current: null, prior: null, since: null, change: null, steady: false },
    ]);
  });

  it('treats a zero prior with a non-zero current as a move, and two zeroes as unchanged', () => {
    const idle = computeDigest([], { date: '2026-07-14' });
    const busy = dayOfPrompt(40_000, '2026-07-15');

    const grew = adviceMovement(provider.advise(busy), busy, idle).find((m) => m.id === 'large-system-prompt');
    expect(grew?.change).toBe(1);
    expect(grew?.steady).toBe(false);

    const stillIdle = adviceMovement(provider.advise(idle), idle, idle).find((m) => m.id === 'no-activity');
    expect(stillIdle?.steady).toBe(true);
  });
});
