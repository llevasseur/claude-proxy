import { describe, expect, it } from 'vitest';
import {
  aggregatePricedRecords,
  createRateTable,
  normalizeModelKey,
  type PricedRecord,
  pricingSourceLabel,
  type RateRow,
  type RateTable,
  rateRowFor,
  resolveRecordCost,
  summarizePricing,
} from '../src/rate-table.js';
import type { AuditTokens } from '../src/types.js';

/**
 * The rate table's resolution rules, as ADRs 0044, 0065 and 0020 state them.
 *
 * Nothing here asserts a count of models. ADR 0065 is explicit that the table
 * grows with every model any provider ships and that the join stays cheap because
 * of its *shape*, so a test pinning the size of the corpus would encode the one
 * reading that decision tells us not to take.
 */

const tokens = (t: Partial<AuditTokens> = {}): AuditTokens => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreation: 0,
  realInput: 0,
  ...t,
});

/** $1/MTok on every bucket, so a million tokens of anything costs exactly $1. */
const UNIT: RateRow = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };

const table = (rows: Record<string, RateRow>, fallback: RateRow | null = null): RateTable =>
  createRateTable({ proxy: 'claude', rows: Object.entries(rows), fallback });

describe('normalizeModelKey', () => {
  it('folds case and surrounding space so one model is one row', () => {
    expect(normalizeModelKey('  Claude-Opus-5 ')).toBe('claude-opus-5');
  });

  it('folds nothing else — a version suffix is part of the model identity', () => {
    expect(normalizeModelKey('claude-opus-5-20260101')).toBe('claude-opus-5-20260101');
  });
});

describe('rateRowFor', () => {
  it('matches a model to its own row', () => {
    const selected = rateRowFor(table({ 'claude-opus-5': UNIT }), 'claude-opus-5');
    expect(selected?.row).toEqual(UNIT);
    expect(selected?.source).toEqual({ kind: 'table', model: 'claude-opus-5' });
  });

  it('matches case-insensitively', () => {
    expect(rateRowFor(table({ 'claude-opus-5': UNIT }), 'Claude-Opus-5')?.source).toEqual({
      kind: 'table',
      model: 'claude-opus-5',
    });
  });

  /**
   * The difference between this table and the family catalogue in `pricing.ts`.
   * A dimension table with a row per model must match that model and no other, or
   * adding a row silently reprices its neighbours.
   */
  it('does not match a longer model name that merely contains a keyed one', () => {
    const t = table({ 'claude-opus-5': UNIT });
    expect(rateRowFor(t, 'claude-opus-5-20260101')).toBeNull();
  });

  it('falls to the declared fallback when the model has no row', () => {
    const fallback: RateRow = { input: 9, output: 9, cacheWrite: 9, cacheRead: 9 };
    const selected = rateRowFor(table({ 'claude-opus-5': UNIT }, fallback), 'gpt-5');
    expect(selected?.row).toEqual(fallback);
    expect(selected?.source).toEqual({ kind: 'fallback', proxy: 'claude' });
  });

  it('answers null when the model has no row and the proxy declares no fallback', () => {
    expect(rateRowFor(table({ 'claude-opus-5': UNIT }), 'gpt-5')).toBeNull();
  });
});

describe('pricingSourceLabel', () => {
  it('writes ADR 0044s stamp for a fallback-priced record', () => {
    expect(pricingSourceLabel({ kind: 'fallback', proxy: 'claude' })).toBe('fallback:claude');
  });

  it('names the table for a model priced by its own row', () => {
    expect(pricingSourceLabel({ kind: 'table', model: 'claude-opus-5' })).toBe('table');
  });
});

describe('resolveRecordCost', () => {
  it('prices a model from its own row and stamps it as such', () => {
    const result = resolveRecordCost(table({ 'claude-opus-5': UNIT }), tokens({ input: 1_000_000 }), 'claude-opus-5');
    expect(result.cost?.total).toBe('1.000000');
    expect(result.pricingSource).toEqual({ kind: 'table', model: 'claude-opus-5' });
    expect(result.unavailableReason).toBeNull();
  });

  it('prices every bucket independently', () => {
    const result = resolveRecordCost(
      table({ m: { input: 1, output: 2, cacheWrite: 4, cacheRead: 8 } }),
      tokens({ input: 1_000_000, output: 1_000_000, cacheCreation: 1_000_000, cacheRead: 1_000_000 }),
      'm',
    );
    expect(result.cost).toMatchObject({
      input: '1.000000',
      output: '2.000000',
      cacheWrite: '4.000000',
      cacheRead: '8.000000',
      total: '15.000000',
    });
  });

  it('prices an unrowed model at the declared fallback, stamped fallback:<proxy>', () => {
    const result = resolveRecordCost(table({}, UNIT), tokens({ output: 2_000_000 }), 'a-brand-new-model');
    expect(result.cost?.total).toBe('2.000000');
    expect(result.pricingSource).toEqual({ kind: 'fallback', proxy: 'claude' });
    // A normal state, not an error — the stamp is what makes it usable in a total
    // and identifiable as an estimate at the same time.
    expect(result.unavailableReason).toBeNull();
  });

  it('reports unknown with a typed reason and a null cost, never zero', () => {
    const result = resolveRecordCost(table({}), tokens({ input: 1_000_000 }), 'gpt-5');
    expect(result.cost).toBeNull();
    expect(result.pricingSource).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'unknown-model', model: 'gpt-5' });
  });

  /**
   * "No model recorded" is a different fact from "model not in the table", so it
   * does not borrow the fallback even where one is declared.
   */
  it('treats an absent model name as unknown even when a fallback is declared', () => {
    const result = resolveRecordCost(table({ 'claude-opus-5': UNIT }, UNIT), tokens({ input: 1 }), '');
    expect(result.cost).toBeNull();
    expect(result.pricingSource).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'unknown-model', model: '' });
    expect(rateRowFor(table({}, UNIT), '   ')).toBeNull();
  });

  /** Zero is a price. A genuinely free bucket bills at nothing and stays priced. */
  it('prices a zero rate as free rather than as unavailable', () => {
    const free: RateRow = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    const result = resolveRecordCost(table({ m: free }), tokens({ input: 5_000_000 }), 'm');
    expect(result.cost?.total).toBe('0.000000');
    expect(result.pricingSource).toEqual({ kind: 'table', model: 'm' });
  });

  /** `null` is not a price. An unconfigured bucket that consumed tokens sinks the cost. */
  it('reports a missing rate on a consumed bucket, naming the model as written', () => {
    const partial: RateRow = { input: 1, output: null, cacheWrite: 1, cacheRead: 1 };
    const result = resolveRecordCost(table({ m: partial }), tokens({ output: 10 }), 'M');
    expect(result.cost).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'missing-category-price', model: 'M', category: 'output' });
  });

  /** ADR 0020's "any consumed usage category", read literally. */
  it('ignores a missing rate on a bucket that consumed nothing', () => {
    const partial: RateRow = { input: 1, output: null, cacheWrite: 1, cacheRead: 1 };
    const result = resolveRecordCost(table({ m: partial }), tokens({ input: 1_000_000 }), 'm');
    expect(result.cost?.total).toBe('1.000000');
    expect(result.unavailableReason).toBeNull();
  });

  it('prices a record that consumed nothing at zero rather than calling it unknown', () => {
    const result = resolveRecordCost(table({ m: UNIT }), tokens(), 'm');
    expect(result.cost?.total).toBe('0.000000');
  });

  /**
   * ADR 0065: "a deleted price row needs no special handling". Removing the row is
   * the whole operation — the next resolve simply finds nothing.
   */
  it('resolves a model whose row was removed against the fallback, or unknown without one', () => {
    const withFallback = resolveRecordCost(table({}, UNIT), tokens({ input: 1_000_000 }), 'was-deleted');
    expect(withFallback.pricingSource).toEqual({ kind: 'fallback', proxy: 'claude' });

    const without = resolveRecordCost(table({}), tokens({ input: 1_000_000 }), 'was-deleted');
    expect(without.cost).toBeNull();
    expect(without.unavailableReason).toEqual({ code: 'unknown-model', model: 'was-deleted' });
  });

  it('reprices the same record when the table changes, with the record untouched', () => {
    const usage = tokens({ input: 1_000_000 });
    const before = resolveRecordCost(table({ m: UNIT }), usage, 'm');
    const after = resolveRecordCost(table({ m: { ...UNIT, input: 4 } }), usage, 'm');
    expect(before.cost?.total).toBe('1.000000');
    expect(after.cost?.total).toBe('4.000000');
    // The only input that changed is the table; the tokens are the same object.
    expect(usage).toEqual(tokens({ input: 1_000_000 }));
  });
});

describe('aggregatePricedRecords', () => {
  it('sums priced records exactly', () => {
    // A hundred thousand tenth-of-a-cent records: summed as floats this lands on
    // 0.09999999999999166, so an exact answer here is the integer path working.
    const one = resolveRecordCost(table({ m: UNIT }), tokens({ input: 1 }), 'm');
    const total = aggregatePricedRecords(Array.from({ length: 100_000 }, () => one));
    expect(total.cost?.total).toBe('0.100000');
  });

  it('propagates unavailability rather than understating the total', () => {
    const priced = resolveRecordCost(table({ m: UNIT }, null), tokens({ input: 1_000_000 }), 'm');
    const unpriced = resolveRecordCost(table({ m: UNIT }, null), tokens({ input: 1_000_000 }), 'other');
    const total = aggregatePricedRecords([priced, unpriced]);
    expect(total.cost).toBeNull();
    expect(total.unavailableReason).toEqual({ code: 'aggregate-incomplete', detail: 'unknown-model' });
  });
});

describe('summarizePricing', () => {
  const t = table({ known: UNIT }, UNIT);
  const priced = (model: string): PricedRecord => resolveRecordCost(t, tokens({ input: 1 }), model);

  it('reports what share of a total rests on fallback rates', () => {
    const summary = summarizePricing([priced('known'), priced('known'), priced('other')]);
    expect(summary).toEqual({ total: 3, fromTable: 2, fromFallback: 1, unpriced: 0, fallbackShare: 1 / 3 });
  });

  it('counts unpriced records without letting them into the share', () => {
    const bare = table({ known: UNIT });
    const summary = summarizePricing([
      resolveRecordCost(bare, tokens({ input: 1 }), 'known'),
      resolveRecordCost(bare, tokens({ input: 1 }), 'other'),
    ]);
    expect(summary).toMatchObject({ total: 2, fromTable: 1, fromFallback: 0, unpriced: 1, fallbackShare: 0 });
  });

  it('leaves the share undefined when nothing was priced', () => {
    expect(summarizePricing([]).fallbackShare).toBeNull();
  });
});
