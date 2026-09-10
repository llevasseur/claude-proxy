import type { DatabaseSync } from 'node:sqlite';
import {
  type AuditTokens,
  createRateTable,
  normalizeModelKey,
  type PricedRecord,
  type RateRow,
  type RateTable,
  resolveRecordCost,
} from '@agent-proxy/claude-core';
import { CLAUDE_PROXY_ID } from './open.js';

/**
 * The rate table's storage, and the read-time resolution that reads it.
 *
 * The split across this file and `stacks/claude/core/src/rate-table.ts` is the
 * repository's core rule rather than a preference: core stays deterministic — no
 * database, no clock, no filesystem — so the *rates* live here and the *rules*
 * live there. This file's whole job is turning two tables into the value core
 * already knows how to resolve against, and it makes no pricing decision of its
 * own.
 *
 * ## Read time means read time
 *
 * [ADR 0065](../../../../../docs/adrs/0065-cost-is-resolved-at-read-time.md)
 * forbids storing `cost` and `pricing_source`, so there is no writer for either
 * here and no column to write them to. {@link resolveCostNow} and
 * {@link costResolverFor} are the only ways a cost is obtained, and both compute
 * it from the table as it stands at the moment of the call. An operator edit
 * therefore reprices history on the very next read, with no backfill and nothing
 * to invalidate.
 *
 * ## Editing a rate writes one row
 *
 * Every mutating function below touches exactly one row of one rate table.
 * Nothing here reads, updates or even opens `request`. That is 0044's "operator
 * correcting a typo" taken literally: a rate edit is an ordinary correction, not
 * a migration, and it has no partial state to recover from because there is only
 * ever one row in flight.
 */

/** One rate table row as stored, with the model key it is filed under. */
export interface ModelRateRecord {
  readonly model: string;
  readonly rates: RateRow;
  readonly updatedAt: string;
}

/** The declared fallback for one proxy. */
export interface ProxyFallbackRecord {
  readonly proxy: string;
  readonly rates: RateRow;
  readonly updatedAt: string;
}

/**
 * A rate row as SQLite answers it. Every rate column is declared `REAL` and
 * nullable, so each is a number or null; `model`/`proxy` and `updated_at` are
 * `TEXT NOT NULL`.
 *
 * Written as a type alias rather than an interface on purpose: an alias carries
 * an implicit index signature, which is what makes it comparable to the open
 * `Record<string, SQLOutputValue>` row type `node:sqlite` returns. An interface
 * has none, so narrowing to it would need a chained assertion through `unknown`
 * — discarding the very type evidence these declarations exist to state.
 */
type RateColumns = {
  input_per_mtok: number | null;
  output_per_mtok: number | null;
  cache_write_per_mtok: number | null;
  cache_read_per_mtok: number | null;
  updated_at: string;
};

type ModelRateColumns = RateColumns & { model: string };
type ProxyRateColumns = RateColumns & { proxy: string };

const RATE_COLUMNS = 'input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, updated_at';

function toRateRow(columns: RateColumns): RateRow {
  return {
    input: columns.input_per_mtok,
    output: columns.output_per_mtok,
    cacheWrite: columns.cache_write_per_mtok,
    cacheRead: columns.cache_read_per_mtok,
  };
}

/** Every rate row, model order, as stored. */
export function listModelRates(db: DatabaseSync): ModelRateRecord[] {
  // SAFETY: the four rate columns are declared REAL and nullable and `model` and
  // `updated_at` are TEXT NOT NULL, which is what `ModelRateColumns` states.
  const rows = db.prepare(`SELECT model, ${RATE_COLUMNS} FROM model_rate ORDER BY model`).all() as ModelRateColumns[];
  return rows.map((row) => ({ model: row.model, rates: toRateRow(row), updatedAt: row.updated_at }));
}

/** One model's row, or `undefined` when the table has none for it. */
export function readModelRate(db: DatabaseSync, model: string): ModelRateRecord | undefined {
  // SAFETY: the same declared shape as `listModelRates`, and `model` is the primary
  // key, so this answers one row or none.
  const row = db
    .prepare(`SELECT model, ${RATE_COLUMNS} FROM model_rate WHERE model = ?`)
    .get(normalizeModelKey(model)) as ModelRateColumns | undefined;
  return row === undefined ? undefined : { model: row.model, rates: toRateRow(row), updatedAt: row.updated_at };
}

/** The proxy's declared fallback, or `undefined` when it declares none. */
export function readProxyFallbackRate(
  db: DatabaseSync,
  proxy: string = CLAUDE_PROXY_ID,
): ProxyFallbackRecord | undefined {
  // SAFETY: the same declared shape, and `proxy` is the primary key.
  const row = db.prepare(`SELECT proxy, ${RATE_COLUMNS} FROM proxy_fallback_rate WHERE proxy = ?`).get(proxy) as
    | ProxyRateColumns
    | undefined;
  return row === undefined ? undefined : { proxy: row.proxy, rates: toRateRow(row), updatedAt: row.updated_at };
}

const UPSERT_MODEL_RATE = `
INSERT INTO model_rate
  (model, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(model) DO UPDATE SET
  input_per_mtok       = excluded.input_per_mtok,
  output_per_mtok      = excluded.output_per_mtok,
  cache_write_per_mtok = excluded.cache_write_per_mtok,
  cache_read_per_mtok  = excluded.cache_read_per_mtok,
  updated_at           = excluded.updated_at
`;

/**
 * Add or correct one model's rates.
 *
 * One row, one statement, no read of any record table — which is what makes ADR
 * 0065's "editing a rate has no write amplification" a property of the code
 * rather than a claim about it. History reprices because the next read resolves
 * against this row, not because anything was rewritten.
 */
export function upsertModelRate(db: DatabaseSync, model: string, rates: RateRow, now = new Date()): void {
  const key = normalizeModelKey(model);
  if (key === '') throw new Error('a rate row needs a model name');
  db.prepare(UPSERT_MODEL_RATE).run(
    key,
    rates.input,
    rates.output,
    rates.cacheWrite,
    rates.cacheRead,
    now.toISOString(),
  );
}

/**
 * Remove one model's row. Answers whether a row was there to remove.
 *
 * Nothing else needs doing: no record points at this row, so the next read simply
 * fails to find it and resolves the model against the declared fallback, or as
 * unknown with a typed reason where the proxy declares none. ADR 0065 chose this
 * over a foreign key precisely so that deleting a rate leaves nothing dangling.
 */
export function deleteModelRate(db: DatabaseSync, model: string): boolean {
  const result = db.prepare('DELETE FROM model_rate WHERE model = ?').run(normalizeModelKey(model));
  return Number(result.changes) > 0;
}

const UPSERT_PROXY_FALLBACK = `
INSERT INTO proxy_fallback_rate
  (proxy, input_per_mtok, output_per_mtok, cache_write_per_mtok, cache_read_per_mtok, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(proxy) DO UPDATE SET
  input_per_mtok       = excluded.input_per_mtok,
  output_per_mtok      = excluded.output_per_mtok,
  cache_write_per_mtok = excluded.cache_write_per_mtok,
  cache_read_per_mtok  = excluded.cache_read_per_mtok,
  updated_at           = excluded.updated_at
`;

/** Declare, or correct, this proxy's fallback rates. */
export function upsertProxyFallbackRate(
  db: DatabaseSync,
  rates: RateRow,
  proxy: string = CLAUDE_PROXY_ID,
  now = new Date(),
): void {
  db.prepare(UPSERT_PROXY_FALLBACK).run(
    proxy,
    rates.input,
    rates.output,
    rates.cacheWrite,
    rates.cacheRead,
    now.toISOString(),
  );
}

/**
 * Withdraw this proxy's declared fallback.
 *
 * A real state rather than a broken one: a proxy with no blanket rate it can
 * defend declares none, and its unpriced models then resolve unknown with a typed
 * reason instead of borrowing a number from somewhere else (ADR 0044).
 */
export function deleteProxyFallbackRate(db: DatabaseSync, proxy: string = CLAUDE_PROXY_ID): boolean {
  const result = db.prepare('DELETE FROM proxy_fallback_rate WHERE proxy = ?').run(proxy);
  return Number(result.changes) > 0;
}

/**
 * The whole rate table as one value, read now.
 *
 * Small by construction — one row per model the corpus contains — which is what
 * lets a query load it once and resolve every record against it in memory
 * instead of joining per row.
 */
export function readRateTable(db: DatabaseSync, proxy: string = CLAUDE_PROXY_ID): RateTable {
  return createRateTable({
    proxy,
    rows: listModelRates(db).map((record) => [record.model, record.rates] as const),
    fallback: readProxyFallbackRate(db, proxy)?.rates ?? null,
  });
}

/**
 * A cost resolver bound to the table **as it stands right now**.
 *
 * Take one of these at the top of a query and use it for every row that query
 * answers: the table is read once, and each record is priced against that
 * snapshot. Do not hold one across requests — the point of ADR 0065 is that the
 * next read sees the operator's latest edit, and a resolver kept alive is exactly
 * the stale cache that decision refuses.
 */
export function costResolverFor(
  db: DatabaseSync,
  proxy: string = CLAUDE_PROXY_ID,
): (tokens: AuditTokens, model: string) => PricedRecord {
  const table = readRateTable(db, proxy);
  return (tokens, model) => resolveRecordCost(table, tokens, model);
}

/**
 * One record's cost, resolved against the table as it stands.
 *
 * Convenience over {@link costResolverFor} for a single record; prefer the
 * resolver when pricing more than one, so the table is read once.
 */
export function resolveCostNow(
  db: DatabaseSync,
  tokens: AuditTokens,
  model: string,
  proxy: string = CLAUDE_PROXY_ID,
): PricedRecord {
  return resolveRecordCost(readRateTable(db, proxy), tokens, model);
}
