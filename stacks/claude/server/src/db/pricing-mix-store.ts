import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  type AuditTokens,
  aggregatePricedRecords,
  type PricedRecord,
  pricingSourceLabel,
  type RateTable,
  resolveRecordCost,
} from '@agent-proxy/claude-core';
import { openDbReadOnly, resolveDbPath } from './open.js';
import { readRateTable } from './rate-table-store.js';

/**
 * What share of this corpus's spend rests on a fallback rate rather than a
 * published one — resolved now, from the rate table as it stands this second.
 *
 * [ADR 0044](../../../../../docs/adrs/0044-every-model-gets-a-price-row.md) line 71
 * gives the `pricing_source` stamp exactly one purpose: "so the dashboard can show
 * what share of a total rests on fallback rates rather than published ones". This
 * module is that question, asked of the whole corpus.
 *
 * ## Nothing here is stored, and that is the entire design
 *
 * [ADR 0065](../../../../../docs/adrs/0065-cost-is-resolved-at-read-time.md) forbids
 * a stored `cost` or `pricing_source`, because both are functions of a table an
 * operator may edit at any moment and freezing them is a cache with no invalidation
 * rule. So this module holds no column, writes nothing, and memoises nothing: every
 * call re-reads {@link readRateTable} and re-resolves every model against it. An
 * operator who corrects a rate on the CRUD page moves this report on the very next
 * read, with no backfill and nothing to invalidate.
 *
 * The read is cheap for the reason 0065 states — the join is a small dimension
 * table against a per-model rollup, not a per-request join. The corpus is folded to
 * one row per distinct model **in SQLite** first, so what reaches the resolver is a
 * handful of rows however many requests they summarise.
 */

/** Tokens for one model, summed across every request that named it. */
type ModelRollupColumns = {
  model: string;
  requests: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cache_read: number | null;
  tokens_cache_creation: number | null;
  tokens_real_input: number | null;
};

/**
 * One row per distinct model, tokens summed.
 *
 * A record with no model recorded is excluded rather than folded into an "unknown"
 * bucket: `rateRowFor` answers `null` for an empty model by design — the fallback
 * says "this model is not in the table", which is a different fact from "this
 * record does not say what produced it" — so such a row could only ever be
 * unpriced, and counting it here would report a pricing problem where there is a
 * provenance one.
 */
const ROLLUP = `
SELECT
  model,
  COUNT(*) AS requests,
  SUM(tokens_input) AS tokens_input,
  SUM(tokens_output) AS tokens_output,
  SUM(tokens_cache_read) AS tokens_cache_read,
  SUM(tokens_cache_creation) AS tokens_cache_creation,
  SUM(tokens_real_input) AS tokens_real_input
FROM request
WHERE model IS NOT NULL AND TRIM(model) <> ''
GROUP BY model
ORDER BY model
`;

/** One model's spend, and the stamp the rate table earns it right now. */
export interface PricingMixModel {
  /** The model as the corpus spells it. */
  readonly model: string;
  /** Requests in the corpus that named this model. */
  readonly requests: number;
  /** Every token this model moved — the real prompt plus the completion. */
  readonly tokens: number;
  /** Cost in USD as an exact decimal string, or `null` when the table can price it no way. */
  readonly cost: string | null;
  /** `table` for a model's own published row, `fallback` for the proxy's declared rate. */
  readonly source: 'table' | 'fallback' | null;
  /** The `<proxy>` in `fallback:<proxy>` — `null` unless `source` is `fallback`. */
  readonly fallbackProxy: string | null;
  /** ADR 0044's stamp as written: `table` or `fallback:<proxy>`. `null` when unpriced. */
  readonly stamp: string | null;
}

/** Spend rolled up by where its rates came from. */
export interface PricingMixBucket {
  /** Distinct models in this bucket. */
  readonly models: number;
  readonly requests: number;
  readonly tokens: number;
  /** Exact USD decimal string. `"0"` for an empty bucket, which is a real total of nothing. */
  readonly cost: string;
}

/**
 * The whole answer, resolved at the moment of the call.
 *
 * `fallbackCostShare` is the figure ADR 0044 line 71 asks for, and its denominator
 * is **priced** spend rather than all spend. That is deliberate and it is stated on
 * the wire rather than left to the reader: an unpriced model has no cost to take a
 * share of, so folding it into the denominator would silently shrink the fallback
 * share by treating an absence as published spend. The unpriced count travels
 * beside it so the figure can be read with its own caveat.
 */
export interface PricingMixReport {
  /** The proxy whose fallback this corpus resolves against — the `<proxy>` in the stamp. */
  readonly proxy: string;
  /** Whether that proxy declares a fallback at all; with none, nothing can be fallback-priced. */
  readonly fallbackDeclared: boolean;
  readonly models: readonly PricingMixModel[];
  readonly published: PricingMixBucket;
  readonly fallback: PricingMixBucket;
  /** Models the table can price no way at all. Cost is `null`, never `0` (ADR 0044). */
  readonly unpriced: Omit<PricingMixBucket, 'cost'>;
  /** Fallback share of **priced** spend, 0–1. `null` when nothing is priced — a share of nothing is undefined. */
  readonly fallbackCostShare: number | null;
  /** The same share counted in requests rather than money, for a corpus whose spend is lopsided. */
  readonly fallbackRequestShare: number | null;
  /** When this was resolved. Nothing here is stored, so the answer is only true as of now. */
  readonly resolvedAt: string;
}

/** One read-only connection per log directory. */
const readers = new Map<string, DatabaseSync>();

/**
 * A read-only handle on the substrate for `logDir`, or `null` when there is none.
 *
 * Read-only for the reason `route-observation-store.ts` gives its own reader: this
 * is a pure read, and it must not migrate a developer's database or leave one
 * behind in a log directory that had none.
 */
function readerFor(logDir: string): DatabaseSync | null {
  const held = readers.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDbReadOnly(logDir);
    readers.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

function tokensOf(row: ModelRollupColumns): AuditTokens {
  const input = row.tokens_input ?? 0;
  const cacheRead = row.tokens_cache_read ?? 0;
  const cacheCreation = row.tokens_cache_creation ?? 0;
  return {
    input,
    output: row.tokens_output ?? 0,
    cacheRead,
    cacheCreation,
    // The stored column where it exists, and its own definition otherwise: a row
    // ingested before `tokens_real_input` was written carries null, not zero.
    realInput: row.tokens_real_input ?? input + cacheRead + cacheCreation,
  };
}

/** Total tokens a rollup row moved — the prompt as sent, plus what came back. */
function totalTokens(tokens: AuditTokens): number {
  return tokens.realInput + tokens.output;
}

/**
 * Resolve one bucket's exact total through core's own aggregation.
 *
 * Every record handed here is priced — the caller split them by `pricingSource`
 * first — so {@link aggregatePricedRecords}'s unavailability propagation cannot
 * fire, and the total is exact decimal arithmetic rather than a float sum.
 */
function bucketCost(records: readonly PricedRecord[]): string {
  if (records.length === 0) return '0';
  const result = aggregatePricedRecords(records);
  return result.cost === null ? '0' : result.cost.total;
}

/** A share as a ratio of two decimal strings, or `null` when the denominator is nothing. */
function share(part: string, whole: string): number | null {
  const denominator = Number(whole);
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return Number(part) / denominator;
}

/**
 * Resolve the corpus's pricing mix against the rate table as it stands now.
 *
 * Exported separately from {@link readPricingMix} so a test can hand it a table
 * and a rollup with no database in sight — the resolution is a pure function of
 * those two, which is what ADR 0065 makes it.
 */
export function summarizePricingMix(
  table: RateTable,
  rollup: readonly ModelRollupColumns[],
  now: Date = new Date(),
): PricingMixReport {
  const models: PricingMixModel[] = [];
  const publishedRecords: PricedRecord[] = [];
  const fallbackRecords: PricedRecord[] = [];
  let published = { models: 0, requests: 0, tokens: 0 };
  let fallback = { models: 0, requests: 0, tokens: 0 };
  let unpriced = { models: 0, requests: 0, tokens: 0 };

  for (const row of rollup) {
    const tokens = tokensOf(row);
    const moved = totalTokens(tokens);
    const priced = resolveRecordCost(table, tokens, row.model);

    if (priced.pricingSource === null) {
      unpriced = {
        models: unpriced.models + 1,
        requests: unpriced.requests + row.requests,
        tokens: unpriced.tokens + moved,
      };
      models.push({
        model: row.model,
        requests: row.requests,
        tokens: moved,
        cost: null,
        source: null,
        fallbackProxy: null,
        stamp: null,
      });
      continue;
    }

    const source = priced.pricingSource;
    if (source.kind === 'fallback') {
      fallbackRecords.push(priced);
      fallback = {
        models: fallback.models + 1,
        requests: fallback.requests + row.requests,
        tokens: fallback.tokens + moved,
      };
    } else {
      publishedRecords.push(priced);
      published = {
        models: published.models + 1,
        requests: published.requests + row.requests,
        tokens: published.tokens + moved,
      };
    }
    models.push({
      model: row.model,
      requests: row.requests,
      tokens: moved,
      cost: priced.cost.total,
      source: source.kind,
      fallbackProxy: source.kind === 'fallback' ? source.proxy : null,
      stamp: pricingSourceLabel(source),
    });
  }

  const publishedBucket: PricingMixBucket = { ...published, cost: bucketCost(publishedRecords) };
  const fallbackBucket: PricingMixBucket = { ...fallback, cost: bucketCost(fallbackRecords) };
  const pricedCost = String(Number(publishedBucket.cost) + Number(fallbackBucket.cost));
  const pricedRequests = publishedBucket.requests + fallbackBucket.requests;

  return {
    proxy: table.proxy,
    fallbackDeclared: table.fallback !== null,
    // Costliest first: the models carrying the money are the ones whose stamp matters.
    models: models.sort((a, b) => Number(b.cost ?? 0) - Number(a.cost ?? 0) || b.tokens - a.tokens),
    published: publishedBucket,
    fallback: fallbackBucket,
    unpriced: { models: unpriced.models, requests: unpriced.requests, tokens: unpriced.tokens },
    fallbackCostShare: share(fallbackBucket.cost, pricedCost),
    fallbackRequestShare: pricedRequests === 0 ? null : fallbackBucket.requests / pricedRequests,
    resolvedAt: now.toISOString(),
  };
}

/**
 * The corpus's pricing mix, or `null` when there is no substrate to read.
 *
 * `null` is "no store here", which the caller reports as such — distinct from an
 * empty report, which is a real measurement of a corpus holding nothing.
 */
export function readPricingMix(logDir: string, now: Date = new Date()): PricingMixReport | null {
  const db = readerFor(logDir);
  if (db === null) return null;
  try {
    // SAFETY: every column ROLLUP selects is either `request.model`, declared TEXT
    // NOT NULL and filtered non-empty by the WHERE clause, or a COUNT/SUM over an
    // INTEGER column — so each value is a string or a number, and a SUM over no rows
    // is the null every token field above is already typed to accept.
    const rollup = db.prepare(ROLLUP).all() as ModelRollupColumns[];
    return summarizePricingMix(readRateTable(db), rollup, now);
  } catch {
    // A database the schema step has not reached has no `model_rate` table and the
    // read throws. That is "nothing to report" rather than a failure of the page.
    return null;
  }
}
