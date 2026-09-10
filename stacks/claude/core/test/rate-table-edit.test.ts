import { describe, expect, it } from 'vitest';
import {
  checkModelName,
  checkRateValue,
  modelNameProblemMessage,
  parseRateField,
  RATE_FIELDS,
  RATE_MAX_DECIMALS,
  rateProblemMessage,
} from '../src/rate-table.js';

/**
 * The rules behind the pricing page's form.
 *
 * They live in core rather than in the page so the form and the request handler
 * ask the same question — a page that accepted what the server rejected would tell
 * an operator their correction landed while the corpus repriced to something else.
 * These tests are the proof of that agreement, so they exercise both entry points:
 * {@link parseRateField} for what someone types, {@link checkRateValue} for what
 * arrives as JSON.
 */

describe('parseRateField', () => {
  it('reads a blank field as not configured rather than as zero', () => {
    // The distinction the whole table turns on: `0` prices a bucket at nothing,
    // `null` says there is no defensible rate for it (ADR 0020).
    expect(parseRateField('')).toEqual({ ok: true, value: null });
    expect(parseRateField('   ')).toEqual({ ok: true, value: null });
    expect(parseRateField('0')).toEqual({ ok: true, value: 0 });
  });

  it('accepts the decimal forms an operator actually types', () => {
    expect(parseRateField('3')).toEqual({ ok: true, value: 3 });
    expect(parseRateField('0.25')).toEqual({ ok: true, value: 0.25 });
    expect(parseRateField('.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseRateField('  15.75  ')).toEqual({ ok: true, value: 15.75 });
  });

  it('refuses what Number() would silently accept', () => {
    // Each of these is a plausible-looking typo that `Number()` turns into a
    // number, and a rate table is exactly where that must not happen.
    for (const text of ['abc', '0x10', '1e5', 'Infinity', '5,5', '$5']) {
      const parsed = parseRateField(text);
      expect(parsed.ok, text).toBe(false);
      if (!parsed.ok) expect(parsed.problem.kind).toBe('not-a-number');
    }
  });

  it('names a negative rate as negative rather than as unparseable', () => {
    const parsed = parseRateField('-1');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.problem).toEqual({ kind: 'negative', value: -1 });
      expect(rateProblemMessage(parsed.problem)).toContain('0 for a free bucket');
    }
  });

  it('holds the same decimal ceiling the catalogue reader holds', () => {
    expect(parseRateField('0.000125')).toEqual({ ok: true, value: 0.000125 });
    const parsed = parseRateField('1.2345678');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problem.kind).toBe('too-precise');
    expect(rateProblemMessage({ kind: 'too-precise', value: 1.2345678 })).toContain(String(RATE_MAX_DECIMALS));
  });

  it('says what is wrong rather than that something is', () => {
    // Criterion: a refusal names the problem. A generic failure message would
    // leave the operator guessing which of the four fields they got wrong.
    for (const text of ['abc', '-1', '1.2345678']) {
      const parsed = parseRateField(text);
      if (!parsed.ok) expect(rateProblemMessage(parsed.problem).length).toBeGreaterThan(20);
    }
  });
});

describe('checkRateValue', () => {
  it('allows an absent rate and refuses an unusable one', () => {
    expect(checkRateValue(null)).toBeNull();
    expect(checkRateValue(0)).toBeNull();
    expect(checkRateValue(12.5)).toBeNull();
    expect(checkRateValue(-0.5)).toMatchObject({ kind: 'negative' });
    expect(checkRateValue(Number.NaN)).toMatchObject({ kind: 'not-a-number' });
    expect(checkRateValue(Number.POSITIVE_INFINITY)).toMatchObject({ kind: 'not-a-number' });
  });

  it('agrees with the text parser on the same value', () => {
    // The two entry points are one rule; this is what stops them drifting.
    for (const text of ['0', '3', '0.25', '-1']) {
      const parsed = parseRateField(text);
      const direct = checkRateValue(Number(text));
      expect(parsed.ok, text).toBe(direct === null);
    }
  });
});

describe('checkModelName', () => {
  it('needs a name', () => {
    expect(checkModelName('', [])).toEqual({ kind: 'empty' });
    expect(checkModelName('   ', [])).toEqual({ kind: 'empty' });
  });

  it('catches a duplicate on the normalized key, not on the typed text', () => {
    // `Claude-Opus-5 ` and `claude-opus-5` are one row. Adding both would leave
    // two rows racing to price the same model.
    const taken = checkModelName('Claude-Opus-5 ', ['claude-opus-5']);
    expect(taken).toEqual({ kind: 'taken', model: 'claude-opus-5' });
    expect(modelNameProblemMessage({ kind: 'taken', model: 'claude-opus-5' })).toContain('claude-opus-5');
  });

  it('allows a model the table does not hold, including a version suffix of one it does', () => {
    // Exact matching is the point: a dated model is its own row, and adding it
    // must not be refused as a duplicate of its family (ADR 0044).
    expect(checkModelName('claude-opus-5-20260101', ['claude-opus-5'])).toBeNull();
  });
});

describe('RATE_FIELDS', () => {
  it('names the four buckets a row prices, and nothing else', () => {
    expect([...RATE_FIELDS]).toEqual(['input', 'output', 'cacheWrite', 'cacheRead']);
  });
});
