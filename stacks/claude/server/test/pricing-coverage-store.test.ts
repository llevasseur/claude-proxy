import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type RateRow, reportDay } from '@agent-proxy/claude-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.js';
import { readPricingCoverage } from '../src/db/pricing-coverage-store.js';
import {
  deleteProxyFallbackRate,
  listModelRates,
  upsertModelRate,
  upsertProxyFallbackRate,
} from '../src/db/rate-table-store.js';

/**
 * Pricing coverage: what share of the corpus can be priced, and why the rest
 * cannot.
 *
 * The assertions that carry weight are the ones about states *not* collapsing.
 * An unpriced record is never counted as a priced one; a record with no model is
 * never answered by the declared fallback; a fully priced corpus reports zero
 * unpriced rather than an absence; and a day's tally is the day's, not the
 * archive's.
 */

const UNIT: RateRow = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };

const MORNING = '2026-08-20T10:00:00.000Z';
const OTHER_DAY = '2026-08-14T10:00:00.000Z';

/**
 * One request row, written directly.
 *
 * Direct SQL rather than an ingest of sidecars because two cases below need a
 * record a sidecar cannot express: a blank model, and a record that consumed
 * exactly one bucket.
 */
function insertRequest(
  db: DatabaseSync,
  id: string,
  model: string,
  tokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    at?: string;
  } = {},
): void {
  const input = tokens.input ?? 0;
  const output = tokens.output ?? 0;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  db.prepare(
    `INSERT INTO request (
       id, source_dir, timestamp, model,
       tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_real_input,
       req_tool_count, req_tools_bytes, req_system_bytes, req_total_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  ).run(id, 'fixtures', tokens.at ?? MORNING, model, input, output, cacheRead, cacheWrite, input);
}

/** Strip migration 24's seeded rows so each case states its own rate table. */
function blankRateTable(db: DatabaseSync): void {
  deleteProxyFallbackRate(db);
  for (const record of listModelRates(db)) {
    db.prepare('DELETE FROM model_rate WHERE model = ?').run(record.model);
  }
}

describe('readPricingCoverage', () => {
  let logDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'pricing-coverage-'));
    db = openDb(logDir);
    blankRateTable(db);
  });

  afterEach(async () => {
    db.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('reports an empty corpus as nothing to price rather than as a gap', () => {
    const { corpus, day } = readPricingCoverage(db);
    expect(corpus.summary.total).toBe(0);
    expect(corpus.summary.unpriced).toBe(0);
    expect(corpus.reasons).toEqual([]);
    // A share of nothing is undefined, not zero — core's own rule.
    expect(corpus.summary.fallbackShare).toBeNull();
    expect(day).toBeNull();
  });

  it('counts records, not distinct model groups', () => {
    for (let i = 0; i < 7; i += 1) insertRequest(db, `r-${i}`, 'mystery-1', { input: 10 });
    const { corpus } = readPricingCoverage(db);
    expect(corpus.summary.total).toBe(7);
    expect(corpus.summary.unpriced).toBe(7);
    expect(corpus.reasons).toHaveLength(1);
    expect(corpus.reasons[0]?.records).toBe(7);
  });

  it('reports an unpriced model as unpriced and never as a priced zero', () => {
    insertRequest(db, 'r-1', 'mystery-1', { input: 10 });
    const { corpus } = readPricingCoverage(db);
    expect(corpus.summary.unpriced).toBe(1);
    expect(corpus.summary.fromTable).toBe(0);
    expect(corpus.summary.fromFallback).toBe(0);
    expect(corpus.reasons[0]?.code).toBe('unknown-model');
    expect(corpus.reasons[0]?.severity).toBe('attention');
  });

  it('moves a model out of unpriced the moment a rate row is added', () => {
    insertRequest(db, 'r-1', 'mystery-1', { input: 10 });
    expect(readPricingCoverage(db).corpus.summary.unpriced).toBe(1);

    upsertModelRate(db, 'mystery-1', UNIT);

    const { corpus } = readPricingCoverage(db);
    expect(corpus.summary.unpriced).toBe(0);
    expect(corpus.summary.fromTable).toBe(1);
    expect(corpus.reasons).toEqual([]);
  });

  it('counts a fallback-priced record as priced, and keeps it distinct from table-priced', () => {
    insertRequest(db, 'r-1', 'mystery-1', { input: 10 });
    insertRequest(db, 'r-2', 'known-1', { input: 10 });
    upsertModelRate(db, 'known-1', UNIT);
    upsertProxyFallbackRate(db, UNIT);

    const { corpus } = readPricingCoverage(db);
    expect(corpus.summary.unpriced).toBe(0);
    expect(corpus.summary.fromTable).toBe(1);
    expect(corpus.summary.fromFallback).toBe(1);
    expect(corpus.summary.fallbackShare).toBeCloseTo(0.5);
  });

  it('does not let a declared fallback price a record with no model recorded', () => {
    upsertProxyFallbackRate(db, UNIT);
    insertRequest(db, 'r-1', '', { input: 10 });

    const { corpus } = readPricingCoverage(db);
    // "Not in the table" and "does not say what produced it" are different facts.
    expect(corpus.summary.unpriced).toBe(1);
    expect(corpus.reasons[0]?.code).toBe('unattributed-record');
  });

  /**
   * ADR 0020 consults a rate only for a bucket that actually spent tokens, so a
   * broken rate on an unused bucket must not sink the record. Keying the memo on
   * the consumption pattern is what keeps that exact.
   */
  it('does not report a missing rate for a bucket the record never consumed', () => {
    upsertModelRate(db, 'partial-1', { input: 1, output: null, cacheWrite: null, cacheRead: null });
    insertRequest(db, 'input-only', 'partial-1', { input: 10 });

    expect(readPricingCoverage(db).corpus.summary.unpriced).toBe(0);

    insertRequest(db, 'also-output', 'partial-1', { input: 10, output: 5 });

    const { corpus } = readPricingCoverage(db);
    expect(corpus.summary.total).toBe(2);
    expect(corpus.summary.unpriced).toBe(1);
    expect(corpus.reasons[0]?.code).toBe('missing-category-price');
  });

  it('orders reasons by how much of the corpus each accounts for', () => {
    insertRequest(db, 'blank-1', '', { input: 10 });
    for (let i = 0; i < 4; i += 1) insertRequest(db, `mystery-${i}`, 'mystery-1', { input: 10 });

    const { corpus } = readPricingCoverage(db);
    expect(corpus.reasons.map((reason) => reason.code)).toEqual(['unknown-model', 'unattributed-record']);
    expect(corpus.reasons.map((reason) => reason.records)).toEqual([4, 1]);
  });

  it('carries a label and a sentence for every reason it reports', () => {
    insertRequest(db, 'r-1', 'mystery-1', { input: 10 });
    for (const reason of readPricingCoverage(db).corpus.reasons) {
      expect(reason.label.trim()).not.toBe('');
      expect(reason.detail.trim()).not.toBe('');
    }
  });

  /**
   * The scope split exists so one bad record in the archive does not condemn
   * every day's total. A day is a reporting day, so the expected key comes from
   * the same function the query uses rather than from a sliced timestamp.
   */
  it('scopes the day tally to that day, leaving the corpus tally whole', () => {
    const today = reportDay(MORNING);
    expect(today).not.toBeNull();
    if (today === null) return;

    upsertModelRate(db, 'known-1', UNIT);
    insertRequest(db, 'today-priced', 'known-1', { input: 10, at: MORNING });
    insertRequest(db, 'archive-unpriced', 'mystery-1', { input: 10, at: OTHER_DAY });

    const { corpus, day } = readPricingCoverage(db, { date: today });
    expect(corpus.summary.total).toBe(2);
    expect(corpus.summary.unpriced).toBe(1);

    expect(day).not.toBeNull();
    expect(day?.date).toBe(today);
    expect(day?.summary.total).toBe(1);
    expect(day?.summary.unpriced).toBe(0);
    expect(day?.reasons).toEqual([]);
  });

  it('reports the day itself as unpriced when that day holds an unpriced record', () => {
    const today = reportDay(MORNING);
    if (today === null) return;
    insertRequest(db, 'today-unpriced', 'mystery-1', { input: 10, at: MORNING });

    const { day } = readPricingCoverage(db, { date: today });
    expect(day?.summary.unpriced).toBe(1);
    expect(day?.reasons[0]?.code).toBe('unknown-model');
  });
});
