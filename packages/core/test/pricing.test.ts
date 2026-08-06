import { describe, expect, it } from 'vitest';
import { estimateCost, FALLBACK_PRICE, MODEL_PRICES, priceFor } from '../src/pricing.js';

describe('priceFor', () => {
  it('matches families by substring', () => {
    expect(priceFor('claude-opus-4-8')).toBe(MODEL_PRICES.opus);
    expect(priceFor('claude-3-5-sonnet-20241022')).toBe(MODEL_PRICES.sonnet);
    expect(priceFor('claude-haiku-4-5')).toBe(MODEL_PRICES.haiku);
  });

  it('matches the model ids actually on the wire', () => {
    // The rows sat a generation stale partly because nothing named the ids the
    // proxy sees. These are what `logs/` carries.
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
  // The one place the sheet's own numbers are pinned, so a price change breaks a
  // test that is about prices rather than one about arithmetic. Opus 5, Sonnet 5,
  // Haiku 4.5 list, $/MTok.
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
    // 1M of each bucket → exactly the row's rates, whatever those rates are. Read
    // off MODEL_PRICES rather than retyped, so this stays a test of the
    // arithmetic and a price change does not land here.
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
