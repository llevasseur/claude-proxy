import { describe, expect, it } from 'vitest';
import { type CostUnavailableReason, describeCostUnavailable, isUnattributedRecord } from '../src/pricing.js';
import { createRateTable, resolveRecordCost } from '../src/rate-table.js';
import type { ProviderUnavailableReason } from '../src/store-absence.js';
import { costUnavailableNotice, providerUnavailableNotice } from '../src/unavailable-notice.js';

const NO_TOKENS = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, realInput: 0 };

describe('isUnattributedRecord', () => {
  it('separates a record with no model from a model with no row', () => {
    expect(isUnattributedRecord({ code: 'unknown-model', model: '' })).toBe(true);
    expect(isUnattributedRecord({ code: 'unknown-model', model: '   ' })).toBe(true);
    expect(isUnattributedRecord({ code: 'unknown-model', model: 'claude-opus-5' })).toBe(false);
  });

  it('is false for reasons that are not about a missing row at all', () => {
    expect(isUnattributedRecord({ code: 'aggregate-incomplete', detail: 'unknown-model' })).toBe(false);
    expect(isUnattributedRecord({ code: 'missing-category-price', model: 'm', category: 'input' })).toBe(false);
  });
});

describe('describeCostUnavailable', () => {
  it('names the model an operator has to add a row for', () => {
    expect(describeCostUnavailable({ code: 'unknown-model', model: 'claude-opus-5' })).toContain('claude-opus-5');
  });

  it('does not tell an unattributed record to add a rate row', () => {
    const sentence = describeCostUnavailable({ code: 'unknown-model', model: '' });
    expect(sentence).toContain('does not say which model produced it');
    expect(sentence).not.toContain('rate row');
  });

  it('names the consumed bucket whose rate is unusable', () => {
    const sentence = describeCostUnavailable({ code: 'missing-category-price', model: 'm', category: 'cacheRead' });
    expect(sentence).toContain('cacheRead');
  });
});

describe('costUnavailableNotice', () => {
  it('never renders an unpriced cost as a zero or an empty label', () => {
    const reasons: CostUnavailableReason[] = [
      { code: 'unknown-model', model: 'claude-opus-5' },
      { code: 'unknown-model', model: '' },
      { code: 'missing-category-price', model: 'm', category: 'output' },
      { code: 'aggregate-incomplete', detail: 'unknown-model' },
    ];
    for (const reason of reasons) {
      const notice = costUnavailableNotice(reason);
      expect(notice.label.trim()).not.toBe('');
      expect(notice.detail.trim()).not.toBe('');
      expect(notice.label).not.toMatch(/^\$?0(\.0+)?$/);
      expect(notice.kind).toBe('cost');
    }
  });

  it('gives the unattributed record its own code, distinct from an unpriced model', () => {
    const unattributed = costUnavailableNotice({ code: 'unknown-model', model: '' });
    const unpriced = costUnavailableNotice({ code: 'unknown-model', model: 'claude-opus-5' });
    expect(unattributed.code).toBe('unattributed-record');
    expect(unpriced.code).toBe('unknown-model');
    expect(unattributed.label).not.toBe(unpriced.label);
  });

  it('treats a derived total as informational rather than a second fault', () => {
    expect(costUnavailableNotice({ code: 'aggregate-incomplete', detail: 'unknown-model' }).severity).toBe(
      'informational',
    );
    expect(costUnavailableNotice({ code: 'unknown-model', model: 'm' }).severity).toBe('attention');
  });

  it('renders the fourth case ticket 06 produces: a record with no model, even where a fallback is declared', () => {
    const table = createRateTable({
      proxy: 'claude',
      rows: [],
      fallback: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
    });
    const priced = resolveRecordCost(table, NO_TOKENS, '');
    expect(priced.cost).toBeNull();
    // A declared fallback prices "not in the table" but never "does not say what
    // produced it", so this must not arrive as an ordinary unpriced model.
    expect(priced.unavailableReason).not.toBeNull();
    if (priced.unavailableReason === null) return;
    expect(costUnavailableNotice(priced.unavailableReason).code).toBe('unattributed-record');
  });
});

describe('providerUnavailableNotice', () => {
  it('agrees with store-absence about which states are faults', () => {
    const absent: ProviderUnavailableReason = { code: 'store-absent', provider: 'openai', path: null };
    const unreadable: ProviderUnavailableReason = {
      code: 'store-unreadable',
      provider: 'openai',
      fault: 'locked',
      detail: 'busy',
    };
    expect(providerUnavailableNotice(absent).severity).toBe('informational');
    expect(providerUnavailableNotice(unreadable).severity).toBe('attention');
  });

  it('speaks the same vocabulary as a cost notice', () => {
    const notice = providerUnavailableNotice({ code: 'store-absent', provider: 'openai', path: null });
    expect(notice.kind).toBe('provider');
    expect(notice.label.trim()).not.toBe('');
    expect(notice.detail.trim()).not.toBe('');
  });

  it('treats an incomplete fan-out as derived, matching an incomplete cost aggregate', () => {
    const notice = providerUnavailableNotice({
      code: 'fanout-incomplete',
      providers: ['openai'],
      detail: 'openai:store-absent',
    });
    expect(notice.severity).toBe('informational');
    expect(notice.label).toBe(costUnavailableNotice({ code: 'aggregate-incomplete', detail: 'x' }).label);
  });
});
