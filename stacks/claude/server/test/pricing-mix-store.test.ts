import { createRateTable, type RateRow } from '@agent-proxy/claude-core';
import { describe, expect, it } from 'vitest';
import { summarizePricingMix } from '../src/db/pricing-mix-store.js';

/**
 * The share-of-fallback figure ADR 0044 line 71 says the stamp exists to produce.
 *
 * Every case here goes through {@link summarizePricingMix} rather than the database
 * reader beside it, because the resolution is a pure function of a rate table and a
 * per-model rollup — which is exactly what ADR 0065 makes it by refusing to store
 * either field. The two cases carrying the most weight are the ones about the
 * **denominator**: an unpriced model must not dilute the fallback share, and a
 * corpus with nothing priced answers `null` rather than `0`.
 */

const rate = (input: number, output: number): RateRow => ({
  input,
  output,
  cacheWrite: input * 1.25,
  cacheRead: input * 0.1,
});

/** One rollup row. Tokens are chosen so each model's cost is easy to reason about. */
function row(model: string, requests: number, input: number, output: number) {
  return {
    model,
    requests,
    tokens_input: input,
    tokens_output: output,
    tokens_cache_read: 0,
    tokens_cache_creation: 0,
    tokens_real_input: input,
  };
}

const AT = new Date('2026-09-10T00:00:00.000Z');

describe('summarizePricingMix', () => {
  it('stamps a model with its own row `table` and one without it `fallback:<proxy>`', () => {
    const table = createRateTable({
      proxy: 'anthropic',
      rows: [['claude-opus-5', rate(15, 75)]],
      fallback: rate(3, 15),
    });

    const report = summarizePricingMix(
      table,
      [row('claude-opus-5', 2, 1_000_000, 0), row('some-new-model', 1, 1_000_000, 0)],
      AT,
    );

    const opus = report.models.find((m) => m.model === 'claude-opus-5');
    const unknown = report.models.find((m) => m.model === 'some-new-model');
    expect(opus?.stamp).toBe('table');
    expect(opus?.fallbackProxy).toBeNull();
    // The proxy is named, because a fallback under one provider says nothing about another.
    expect(unknown?.stamp).toBe('fallback:anthropic');
    expect(unknown?.fallbackProxy).toBe('anthropic');
  });

  it('takes the fallback share of priced spend, not of all spend', () => {
    // A fallback that states an input rate and no output one. That is the shape an
    // unpriced record actually takes once a fallback is declared: with one in place
    // every named model resolves *somehow*, so the only way left to be unpriced is a
    // bucket the selected row cannot rate — ADR 0020's consumed-bucket rule.
    const table = createRateTable({
      proxy: 'anthropic',
      rows: [['published-model', { input: 10, output: 10, cacheWrite: 12.5, cacheRead: 1 }]],
      fallback: { input: 10, output: null, cacheWrite: 12.5, cacheRead: 1 },
    });

    const report = summarizePricingMix(
      table,
      [
        // Its own row, input only: the published half of the denominator.
        row('published-model', 1, 1_000_000, 0),
        // No row, input only: takes the fallback at the same rate, so the share is a half.
        row('borrowed-model', 1, 1_000_000, 0),
        // No row and output tokens the fallback cannot rate: unpriced, and much the
        // largest thing in the corpus — which is what makes it a real test of the
        // denominator rather than a rounding one.
        row('unratable-model', 8, 0, 5_000_000),
      ],
      AT,
    );

    expect(report.fallbackCostShare).toBeCloseTo(0.5, 10);
    expect(report.fallbackRequestShare).toBeCloseTo(0.5, 10);
    // The unpriced model is still reported — kept out of the shares, not out of sight.
    expect(report.unpriced.models).toBe(1);
    expect(report.unpriced.requests).toBe(8);
    expect(report.models.find((m) => m.model === 'unratable-model')?.cost).toBeNull();
  });

  it('answers `null` rather than `0` when nothing is priced', () => {
    const table = createRateTable({ proxy: 'anthropic', rows: [], fallback: null });
    const report = summarizePricingMix(table, [row('anything', 3, 1_000, 1_000)], AT);

    // A share of nothing is undefined, not zero — the same rule `summarizePricing` keeps.
    expect(report.fallbackCostShare).toBeNull();
    expect(report.fallbackRequestShare).toBeNull();
    expect(report.models[0]?.cost).toBeNull();
    expect(report.models[0]?.stamp).toBeNull();
  });

  it('moves the moment the table does, with nothing to invalidate', () => {
    const rollup = [row('drifting-model', 1, 1_000_000, 0)];
    const before = summarizePricingMix(
      createRateTable({ proxy: 'anthropic', rows: [], fallback: rate(10, 10) }),
      rollup,
      AT,
    );
    // The operator adds the model's own row. Same corpus, same call, new answer —
    // ADR 0065's read-time resolution, with no backfill in between.
    const after = summarizePricingMix(
      createRateTable({ proxy: 'anthropic', rows: [['drifting-model', rate(10, 10)]], fallback: rate(10, 10) }),
      rollup,
      AT,
    );

    expect(before.fallbackCostShare).toBe(1);
    expect(before.models[0]?.stamp).toBe('fallback:anthropic');
    expect(after.fallbackCostShare).toBe(0);
    expect(after.models[0]?.stamp).toBe('table');
  });

  it('reports whether the proxy declares a fallback at all', () => {
    const none = createRateTable({ proxy: 'anthropic', rows: [], fallback: null });
    const some = createRateTable({ proxy: 'anthropic', rows: [], fallback: rate(1, 1) });

    expect(summarizePricingMix(none, [], AT).fallbackDeclared).toBe(false);
    expect(summarizePricingMix(some, [], AT).fallbackDeclared).toBe(true);
  });

  it('excludes a record that names no model rather than calling it unpriced', () => {
    // The SQL rollup filters these out; this asserts the resolver agrees, so a caller
    // handing it an unfiltered rollup cannot report a provenance gap as a pricing one.
    const table = createRateTable({ proxy: 'anthropic', rows: [], fallback: rate(1, 1) });
    const report = summarizePricingMix(table, [row('  ', 4, 1_000, 0)], AT);

    // An empty model takes neither branch: no fallback is applied to a record nothing
    // is known about, so it lands unpriced with no stamp.
    expect(report.models[0]?.stamp).toBeNull();
    expect(report.fallback.requests).toBe(0);
  });
});
