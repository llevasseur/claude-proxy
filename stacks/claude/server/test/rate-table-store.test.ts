import fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { aggregatePricedRecords, pricingSourceLabel, type RateRow } from '@agent-proxy/claude-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { CLAUDE_PROXY_ID, openDb, resolveDbPath, SCHEMA_VERSION } from '../src/db/open.js';
import {
  costResolverFor,
  deleteModelRate,
  deleteProxyFallbackRate,
  listModelRates,
  readModelRate,
  readProxyFallbackRate,
  readRateTable,
  resolveCostNow,
  upsertModelRate,
  upsertProxyFallbackRate,
} from '../src/db/rate-table-store.js';

/**
 * Migration 24 and the rate table's storage.
 *
 * The cases the ticket's own criteria name are all here, and the two that carry
 * the most weight are the ones about what does **not** happen: editing a rate
 * writes nothing to `request`, and deleting a row leaves nothing dangling. Both
 * are assertions about ADR 0065 being implemented rather than merely intended.
 */

type SqlValue = string | number | null;
type SqlRow = Record<string, SqlValue>;

function queryAll(db: DatabaseSync, sql: string, ...params: string[]): SqlRow[] {
  // SAFETY: every column these queries select is declared TEXT, INTEGER or REAL,
  // and none is a blob, so each value is a string, a number, or null.
  return db.prepare(sql).all(...params) as SqlRow[];
}

function queryOne(db: DatabaseSync, sql: string, ...params: string[]): SqlRow | undefined {
  // SAFETY: the same invariant as `queryAll`.
  return db.prepare(sql).get(...params) as SqlRow | undefined;
}

const TOKENS = { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 1_000_000 };
const UNIT: RateRow = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };

function sidecarBody(model: string) {
  return {
    timestamp: '2026-08-20T10:00:00.000Z',
    model,
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: 's-1', app: 'claude-code', userAgent: 'claude-cli/2.0' },
    skim: { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null },
  };
}

async function writeTriple(dir: string, stem: string, model: string): Promise<void> {
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecarBody(model)), 'utf8');
  await writeFile(path.join(dir, `${stem}.md`), '# capture\n', 'utf8');
  await writeFile(
    path.join(dir, `${stem}.request.txt`),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }] }),
    'utf8',
  );
}

describe('migration 24 — the rate table', () => {
  let logDir: string;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'rate-table-'));
  });

  afterEach(async () => {
    await rm(logDir, { recursive: true, force: true });
  });

  it('creates both rate tables and lands on the current schema version', () => {
    const db = openDb(logDir);
    expect(Number(queryOne(db, 'PRAGMA user_version')?.user_version)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(24);

    const tables = queryAll(db, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name);
    expect(tables).toContain('model_rate');
    expect(tables).toContain('proxy_fallback_rate');
    db.close();
  });

  /** ADR 0044 keeps one current rate per model: no dating, no history. */
  it('carries no effective dating on either rate table', () => {
    const db = openDb(logDir);
    for (const table of ['model_rate', 'proxy_fallback_rate']) {
      const columns = queryAll(db, 'SELECT name FROM pragma_table_info(?)', table).map((row) => row.name);
      expect(columns).not.toContain('valid_from');
      expect(columns).not.toContain('valid_to');
      expect(columns).not.toContain('superseded_at');
      expect(columns).toContain('updated_at');
    }
    db.close();
  });

  /**
   * ADR 0065: neither field is stored on the record tier or on the rate tables
   * themselves — those are the three tables the decision governs, and the same
   * absence `migration-23-record-stamp` already asserts for `request`.
   *
   * The sweep is deliberately not "every table in the database". `command_run_step`
   * carries a `cost` column of its own, a per-step figure derived by the command
   * analytics long before this campaign and unrelated to a request's
   * `pricing_source`. Widening this assertion to catch it would not be enforcing
   * 0065; it would be failing on a different tier's pre-existing design.
   */
  it('stores no cost and no pricing_source column on the record or rate tables', () => {
    const db = openDb(logDir);
    for (const table of ['request', 'model_rate', 'proxy_fallback_rate']) {
      const columns = queryAll(db, 'SELECT name FROM pragma_table_info(?)', table).map((row) => row.name);
      expect(columns, `table ${table}`).not.toContain('cost');
      expect(columns, `table ${table}`).not.toContain('pricing_source');
    }
    db.close();
  });

  it('declares this proxys fallback so an unrowed model is still priced', () => {
    const db = openDb(logDir);
    const fallback = readProxyFallbackRate(db);
    expect(fallback?.proxy).toBe(CLAUDE_PROXY_ID);
    expect(fallback?.rates.input).toBeGreaterThan(0);
    db.close();
  });

  it('seeds a row for each model the corpus already contains', async () => {
    await writeTriple(logDir, '2026-08-20T10-00-00-000_anthropic', 'claude-opus-5');
    await writeTriple(logDir, '2026-08-20T11-00-00-000_anthropic', 'claude-haiku-4-5');

    const seeding = openDb(logDir);
    await ingest(seeding, logDir);
    // Put the file back below the rung so the next open runs it against a corpus.
    seeding.exec('DROP TABLE model_rate');
    seeding.exec('DROP TABLE proxy_fallback_rate');
    seeding.exec('PRAGMA user_version = 23');
    seeding.close();

    const db = openDb(logDir);
    const models = listModelRates(db).map((record) => record.model);
    expect(models).toContain('claude-opus-5');
    expect(models).toContain('claude-haiku-4-5');
    // Priced from the catalogue the two families already have, not from a guess.
    expect(readModelRate(db, 'claude-haiku-4-5')?.rates.input).toBe(1);
    expect(readModelRate(db, 'claude-opus-5')?.rates.input).toBe(5);
    db.close();
  });

  it('never overwrites an operator edit when the rung is re-reached', async () => {
    await writeTriple(logDir, '2026-08-20T10-00-00-000_anthropic', 'claude-opus-5');
    const seeding = openDb(logDir);
    await ingest(seeding, logDir);
    upsertModelRate(seeding, 'claude-opus-5', { input: 42, output: 42, cacheWrite: 42, cacheRead: 42 });
    seeding.exec('PRAGMA user_version = 23');
    seeding.close();

    const db = openDb(logDir);
    expect(readModelRate(db, 'claude-opus-5')?.rates.input).toBe(42);
    db.close();
  });

  it('never deletes, recreates or truncates the database file', async () => {
    await writeTriple(logDir, '2026-08-20T10-00-00-000_anthropic', 'claude-opus-5');
    const seeding = openDb(logDir);
    await ingest(seeding, logDir);
    seeding.exec('PRAGMA user_version = 23');
    seeding.close();

    const dbPath = resolveDbPath(logDir);
    const before = fs.statSync(dbPath);
    const migrated = openDb(logDir);
    migrated.close();
    const after = fs.statSync(dbPath);

    expect(after.ino).toBe(before.ino);
    expect(after.birthtimeMs).toBe(before.birthtimeMs);
  });
});

describe('cost resolved at read time', () => {
  let logDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'read-time-cost-'));
    db = openDb(logDir);
    // A table this suite owns outright, so no assertion rests on what was seeded.
    db.exec('DELETE FROM model_rate');
    upsertModelRate(db, 'claude-opus-5', UNIT);
  });

  afterEach(async () => {
    db.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('prices a model from its own row', () => {
    const result = resolveCostNow(db, TOKENS, 'claude-opus-5');
    expect(result.cost?.total).toBe('1.000000');
    expect(result.pricingSource && pricingSourceLabel(result.pricingSource)).toBe('table');
  });

  /**
   * Criterion: editing a rate changes historical totals **with no write to any
   * record**. The record snapshot is taken column by column on both sides, so a
   * migration-style backfill could not slip past it.
   */
  it('reprices history on a rate edit without writing to any record', async () => {
    await writeTriple(logDir, '2026-08-20T10-00-00-000_anthropic', 'claude-opus-5');
    await ingest(db, logDir);

    const recordsBefore = queryAll(db, 'SELECT * FROM request ORDER BY id');
    expect(recordsBefore.length).toBe(1);
    const before = resolveCostNow(db, TOKENS, 'claude-opus-5');
    expect(before.cost?.total).toBe('1.000000');

    upsertModelRate(db, 'claude-opus-5', { ...UNIT, input: 7 });

    const after = resolveCostNow(db, TOKENS, 'claude-opus-5');
    expect(after.cost?.total).toBe('7.000000');

    const recordsAfter = queryAll(db, 'SELECT * FROM request ORDER BY id');
    expect(recordsAfter.length).toBe(recordsBefore.length);
    for (const [index, priorRow] of recordsBefore.entries()) {
      for (const [column, value] of Object.entries(priorRow)) {
        expect(recordsAfter[index]?.[column], `column ${column}`).toStrictEqual(value);
      }
    }
  });

  /** No backfill, no bulk update: the edit is one row of one table. */
  it('touches exactly one rate row per edit', () => {
    upsertModelRate(db, 'claude-haiku-4-5', UNIT);
    const before = listModelRates(db);
    upsertModelRate(db, 'claude-opus-5', { ...UNIT, output: 3 });
    const after = listModelRates(db);

    expect(after.length).toBe(before.length);
    expect(after.find((r) => r.model === 'claude-haiku-4-5')).toStrictEqual(
      before.find((r) => r.model === 'claude-haiku-4-5'),
    );
    expect(after.find((r) => r.model === 'claude-opus-5')?.rates.output).toBe(3);
  });

  /** Criterion: a fallback row resolves with the `fallback:<proxy>` stamp. */
  it('prices an unrowed model at the declared fallback and stamps its source', () => {
    upsertProxyFallbackRate(db, { input: 2, output: 2, cacheWrite: 2, cacheRead: 2 });
    const result = resolveCostNow(db, TOKENS, 'a-model-with-no-row');

    expect(result.cost?.total).toBe('2.000000');
    expect(result.pricingSource && pricingSourceLabel(result.pricingSource)).toBe('fallback:claude');
    expect(result.unavailableReason).toBeNull();
  });

  /** Criterion: no rate row → unknown, typed reason, `null` cost — never `0`. */
  it('reports a model with no row and no fallback as unknown with a null cost', () => {
    deleteProxyFallbackRate(db);
    const result = resolveCostNow(db, TOKENS, 'a-model-with-no-row');

    expect(result.cost).toBeNull();
    expect(result.pricingSource).toBeNull();
    expect(result.unavailableReason).toEqual({ code: 'unknown-model', model: 'a-model-with-no-row' });
  });

  /** Criterion: deleting a rate row resolves unknown on the next read, not dangling. */
  it('resolves a deleted models records as unknown on the very next read', () => {
    deleteProxyFallbackRate(db);
    expect(resolveCostNow(db, TOKENS, 'claude-opus-5').cost?.total).toBe('1.000000');

    expect(deleteModelRate(db, 'claude-opus-5')).toBe(true);

    const after = resolveCostNow(db, TOKENS, 'claude-opus-5');
    expect(after.cost).toBeNull();
    expect(after.unavailableReason).toEqual({ code: 'unknown-model', model: 'claude-opus-5' });
    // Nothing was left pointing at the removed row.
    expect(readModelRate(db, 'claude-opus-5')).toBeUndefined();
    expect(deleteModelRate(db, 'claude-opus-5')).toBe(false);
  });

  it('falls a deleted models records to the fallback when one is declared', () => {
    upsertProxyFallbackRate(db, { input: 5, output: 5, cacheWrite: 5, cacheRead: 5 });
    deleteModelRate(db, 'claude-opus-5');

    const after = resolveCostNow(db, TOKENS, 'claude-opus-5');
    expect(after.cost?.total).toBe('5.000000');
    expect(after.pricingSource && pricingSourceLabel(after.pricingSource)).toBe('fallback:claude');
  });

  it('reads the table once for a batch and prices every record against it', () => {
    upsertProxyFallbackRate(db, UNIT);
    const resolve = costResolverFor(db);
    const priced = ['claude-opus-5', 'claude-opus-5', 'unrowed'].map((model) => resolve(TOKENS, model));

    expect(aggregatePricedRecords(priced).cost?.total).toBe('3.000000');
    expect(priced.map((p) => p.pricingSource && pricingSourceLabel(p.pricingSource))).toEqual([
      'table',
      'table',
      'fallback:claude',
    ]);
  });

  it('files a model under one row however it is cased or spaced', () => {
    upsertModelRate(db, '  Claude-Sonnet-5 ', UNIT);
    expect(readModelRate(db, 'claude-sonnet-5')?.rates).toEqual(UNIT);
    expect(readRateTable(db).rows.get('claude-sonnet-5')).toEqual(UNIT);
  });

  it('refuses a rate row with no model to file it under', () => {
    expect(() => upsertModelRate(db, '   ', UNIT)).toThrow(/model name/);
  });
});
