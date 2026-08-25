import { describe, expect, it } from 'vitest';
import {
  addCost,
  addUsdAmounts,
  aggregateCost,
  type CostResult,
  estimateCost,
  FALLBACK_PRICE,
  MODEL_PRICES,
  type ModelPrice,
  priceFor,
  priceRowFor,
  resolveCost,
  ZERO_COST,
} from '../src/pricing.js';

const tokens = (t: Partial<Parameters<typeof estimateCost>[0]> = {}) => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  realInput: 0,
  ...t,
});

describe('priceFor', () => {
  it('matches families by substring', () => {
    expect(priceFor('claude-opus-4-8')).toBe(MODEL_PRICES.opus);
    expect(priceFor('claude-3-5-sonnet-20241022')).toBe(MODEL_PRICES.sonnet);
    expect(priceFor('claude-haiku-4-5')).toBe(MODEL_PRICES.haiku);
  });

  it('matches the model ids actually on the wire', () => {
    expect(priceFor('claude-opus-5')).toBe(MODEL_PRICES.opus);
    expect(priceFor('claude-sonnet-5')).toBe(MODEL_PRICES.sonnet);
    expect(priceFor('claude-haiku-4-5-20251001')).toBe(MODEL_PRICES.haiku);
  });

  it('falls back for unknown models', () => {
    expect(priceFor('gpt-5')).toBe(FALLBACK_PRICE);
    expect(priceFor('')).toBe(FALLBACK_PRICE);
  });
});

describe('MODEL_PRICES', () => {
  // The one place the sheet's own values are pinned. Opus 5, Sonnet 5, Haiku 4.5
  // list, $/MTok.
  it('carries the current generation, not the one before it', () => {
    expect(MODEL_PRICES.opus).toEqual({ input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 });
    expect(MODEL_PRICES.sonnet).toEqual({ input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 });
    expect(MODEL_PRICES.haiku).toEqual({ input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 });
  });

  it('keeps cache writes at 1.25x input and cache reads at 0.1x', () => {
    for (const [family, p] of Object.entries(MODEL_PRICES)) {
      expect(p.cacheWrite / p.input, `${family} cacheWrite`).toBeCloseTo(1.25, 10);
      expect(p.cacheRead / p.input, `${family} cacheRead`).toBeCloseTo(0.1, 10);
    }
  });

  it('leaves the fallback mirroring the sonnet row', () => {
    expect(FALLBACK_PRICE).toEqual(MODEL_PRICES.sonnet);
  });
});

describe('estimateCost', () => {
  it('prices each token bucket at its rate', () => {
    // 1M of each bucket → exactly the row's rates, read off MODEL_PRICES rather
    // than retyped.
    const opus = MODEL_PRICES.opus!;
    const cost = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000, realInput: 3_000_000 },
      'claude-opus-5',
    );
    expect(cost.input).toBeCloseTo(opus.input);
    expect(cost.output).toBeCloseTo(opus.output);
    expect(cost.cacheRead).toBeCloseTo(opus.cacheRead);
    expect(cost.cacheWrite).toBeCloseTo(opus.cacheWrite);
    expect(cost.total).toBeCloseTo(opus.input + opus.output + opus.cacheRead + opus.cacheWrite);
  });

  it('is zero for zero tokens', () => {
    const cost = estimateCost({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 }, 'claude-opus-4-8');
    expect(cost.total).toBe(0);
  });
});

describe('priceRowFor', () => {
  it('reports the miss instead of covering it', () => {
    expect(priceRowFor('gpt-5')).toBeNull();
    expect(priceRowFor('')).toBeNull();
  });

  it('matches the same families priceFor does', () => {
    expect(priceRowFor('claude-opus-5')).toBe(MODEL_PRICES.opus);
    expect(priceRowFor('claude-sonnet-5')).toBe(MODEL_PRICES.sonnet);
  });
});

describe('resolveCost', () => {
  it('prices each bucket exactly, as decimal strings', () => {
    const result = resolveCost(
      tokens({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheCreation: 1_000_000 }),
      'claude-opus-5',
    );
    expect(result.unavailableReason).toBeNull();
    expect(result.cost).toEqual({
      currency: 'USD',
      input: '5.000000',
      output: '25.000000',
      cacheWrite: '6.250000',
      cacheRead: '0.500000',
      total: '36.750000',
    });
  });

  it('agrees with the float path for priced models', () => {
    const t = tokens({ input: 123_456, output: 7_890, cacheRead: 654_321, cacheCreation: 42_000 });
    const exact = resolveCost(t, 'claude-sonnet-5');
    const float = estimateCost(t, 'claude-sonnet-5');
    expect(Number(exact.cost?.total)).toBeCloseTo(float.total, 9);
  });

  it('marks an unpriced model unavailable rather than substituting zero', () => {
    const result = resolveCost(tokens({ input: 1_000_000 }), 'gpt-5');
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'unknown-model', model: 'gpt-5' });
    // The gap this closes: the float path silently bills an unknown model at the
    // fallback row, which reads as a real measurement.
    expect(estimateCost(tokens({ input: 1_000_000 }), 'gpt-5').total).toBe(FALLBACK_PRICE.input);
  });

  it('reports an unusable rate on a consumed bucket', () => {
    const broken: Record<string, ModelPrice> = {
      opus: { input: Number.NaN, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    };
    const result = resolveCost(tokens({ input: 10 }), 'claude-opus-5', broken);
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'missing-category-price', model: 'claude-opus-5', category: 'input' });
  });

  it('ignores an unusable rate on a bucket that consumed nothing', () => {
    const broken: Record<string, ModelPrice> = {
      opus: { input: Number.NaN, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
    };
    const result = resolveCost(tokens({ output: 1_000_000 }), 'claude-opus-5', broken);
    expect(result.unavailableReason).toBeNull();
    expect(result.cost?.total).toBe('25.000000');
  });

  it('totals zero tokens as a real zero, not an unavailable cost', () => {
    const result = resolveCost(tokens(), 'claude-opus-5');
    expect(result.unavailableReason).toBeNull();
    expect(result.cost?.total).toBe('0.000000');
  });

  it('refuses a negative or fractional token count', () => {
    expect(() => resolveCost(tokens({ input: -1 }), 'claude-opus-5')).toThrow(RangeError);
    expect(() => resolveCost(tokens({ input: 1.5 }), 'claude-opus-5')).toThrow(RangeError);
  });
});

describe('addUsdAmounts', () => {
  it('is exact where floating point drifts', () => {
    // The canonical drift: ten tenths do not sum to one in binary floating point.
    const tenths = Array.from({ length: 10 }, () => '0.100000');
    expect(tenths.reduce((a, b) => a + Number(b), 0)).not.toBe(1);
    expect(addUsdAmounts(tenths)).toBe('1.000000');
  });

  it('adds fractions of a cent without losing them', () => {
    expect(addUsdAmounts(['0.100000', '0.200000'])).toBe('0.300000');
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addUsdAmounts(Array.from({ length: 1_000_000 }, () => '0.000001'))).toBe('1.000000');
  });

  it('totals an empty list as zero', () => {
    expect(addUsdAmounts([])).toBe('0.000000');
  });

  it('rejects an amount it did not produce', () => {
    expect(() => addUsdAmounts(['-1.000000'])).toThrow(/invalid USD amount/);
    expect(() => addUsdAmounts(['1e-6'])).toThrow(/invalid USD amount/);
  });
});

describe('aggregateCost', () => {
  it('sums priced costs exactly', () => {
    const one = resolveCost(tokens({ cacheRead: 1_000_000 }), 'claude-haiku-4-5');
    expect(one.cost?.total).toBe('0.100000');
    const ten = aggregateCost(Array.from({ length: 10 }, () => one));
    expect(ten.cost?.total).toBe('1.000000');

    // Same ten days down the float path, which is what this replaces.
    const drifted = Array.from({ length: 10 }, () =>
      estimateCost(tokens({ cacheRead: 1_000_000 }), 'claude-haiku-4-5'),
    ).reduce(addCost, ZERO_COST);
    expect(drifted.total).not.toBe(1);
  });

  it('propagates unavailability rather than understating the total', () => {
    const priced = resolveCost(tokens({ input: 1_000_000 }), 'claude-opus-5');
    const unpriced = resolveCost(tokens({ input: 1_000_000 }), 'gpt-5');
    const result = aggregateCost([priced, unpriced]);
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'aggregate-incomplete', detail: 'unknown-model' });
  });

  it('totals an empty aggregate as zero', () => {
    const result: CostResult = aggregateCost([]);
    expect(result.unavailableReason).toBeNull();
    expect(result.cost?.total).toBe('0.000000');
  });
});
