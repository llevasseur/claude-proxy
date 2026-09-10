import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import {
  type AuditTokens,
  costUnavailableNotice,
  type PricedRecord,
  type PricingSummary,
  pricingSummaryFrom,
  reportDay,
  type UnavailableNotice,
} from '@agent-proxy/claude-core';
import { CLAUDE_PROXY_ID } from './open.js';
import { costResolverFor } from './rate-table-store.js';

/**
 * How much of this proxy's corpus can be priced, and why the rest cannot.
 *
 * This is the question [ADR 0044](../../../../../docs/adrs/0044-every-model-gets-a-price-row.md)
 * line 71 says the `pricing_source` stamp exists to answer, asked of a whole
 * corpus rather than of one record. Without it the unpriced state is only ever
 * *encountered*: you meet it on a row and have no way to ask how much else is
 * like that.
 *
 * ## Resolved now, stored nowhere
 *
 * Every number here is computed against the rate table as it stands at the
 * moment of the call, per [ADR 0065](../../../../../docs/adrs/0065-cost-is-resolved-at-read-time.md).
 * There is no coverage column and nothing to invalidate: an operator who adds a
 * missing rate row sees these move on the next read.
 *
 * ## Two scopes, because they answer different questions
 *
 * `corpus` is the discoverability figure — what share of everything is unpriced.
 * `day` is the one an aggregate needs: ADR 0044 makes a total containing an
 * unpriced record unavailable, so a surface showing one day's cost has to know
 * about that day, and a corpus-wide count would condemn every day for one bad
 * record in the archive. Both come from one pass, so they cannot disagree.
 *
 * ## Why the day is bucketed in JS rather than in SQL
 *
 * A reporting day is a day in {@link reportDay}'s timezone, not a UTC one, so
 * `substr(timestamp, 1, 10)` is the wrong answer twice a year and near midnight
 * every day. The one rule the rest of the dashboard already uses is the rule
 * used here, applied per row.
 *
 * ## Why availability is memoized by (model, consumption pattern)
 *
 * Whether a record can be priced depends on exactly two things: its model, and
 * **which buckets it actually spent tokens in** — ADR 0020 consults a rate only
 * for a consumed bucket. Two records agreeing on both resolve identically
 * whatever their counts, so one resolution per distinct pair classifies the
 * whole corpus exactly. Keying on the model alone would not: it would have to
 * sum tokens first, marking a bucket consumed because *some* record used it, and
 * would then report `missing-category-price` against records that never touched
 * it — a fault reported where the honest answer is that the rate was never
 * needed.
 */

/** One reason, and how many records carry it. */
export interface PricingCoverageReason {
  /** The notice code — `unknown-model`, `unattributed-record`, `missing-category-price`. */
  readonly code: string;
  /** The notice's short label, so every surface renders the same words. */
  readonly label: string;
  /** The sentence for a representative record in this group. */
  readonly detail: string;
  readonly severity: UnavailableNotice['severity'];
  readonly records: number;
}

/** Coverage over one set of records. `reasons` is empty exactly when `summary.unpriced` is zero. */
export interface PricingCoverage {
  readonly summary: PricingSummary;
  /** Descending by record count, so the biggest gap an operator could close is first. */
  readonly reasons: readonly PricingCoverageReason[];
}

/** Coverage at both scopes. `day` is `null` when the caller named no day. */
export interface PricingCoverageReport {
  readonly corpus: PricingCoverage;
  readonly day: (PricingCoverage & { readonly date: string }) | null;
}

/** One grouped row, after the boundary read below has turned it into domain values. */
interface CoverageRow {
  readonly timestamp: string;
  readonly model: string;
  readonly usedInput: boolean;
  readonly usedOutput: boolean;
  readonly usedCacheWrite: boolean;
  readonly usedCacheRead: boolean;
}

/**
 * Read one SQLite row into {@link CoverageRow}.
 *
 * Converted rather than asserted. `timestamp` and `model` are `TEXT NOT NULL` on
 * `request`, and the four `used_*` are SQLite comparisons, which yield integer 1
 * or 0 and never null — so this restates the schema's own guarantees as values
 * instead of telling the compiler to take them on trust.
 */
function toCoverageRow(raw: Record<string, SQLOutputValue>): CoverageRow {
  return {
    timestamp: String(raw.timestamp ?? ''),
    model: String(raw.model ?? ''),
    usedInput: Number(raw.used_input) === 1,
    usedOutput: Number(raw.used_output) === 1,
    usedCacheWrite: Number(raw.used_cache_write) === 1,
    usedCacheRead: Number(raw.used_cache_read) === 1,
  };
}

/**
 * Four flags rather than four counts: only whether a bucket was consumed decides
 * availability, so the counts themselves need never leave SQLite.
 */
const COVERAGE_ROWS = `
  SELECT timestamp                        AS timestamp,
         model                            AS model,
         tokens_input          > 0        AS used_input,
         tokens_output         > 0        AS used_output,
         tokens_cache_creation > 0        AS used_cache_write,
         tokens_cache_read     > 0        AS used_cache_read
    FROM request
`;

/**
 * A stand-in for one (model, pattern) pair: one token in each consumed bucket,
 * zero in the rest. The count never changes whether a cost is available — only
 * consumption does — so this resolves to the pair's real outcome.
 */
function standInTokens(row: CoverageRow): AuditTokens {
  return {
    input: row.usedInput ? 1 : 0,
    output: row.usedOutput ? 1 : 0,
    cacheCreation: row.usedCacheWrite ? 1 : 0,
    cacheRead: row.usedCacheRead ? 1 : 0,
    // Not a billed bucket: `resolveCost` prices the four above and never reads
    // this one, so it takes no part in whether a cost is available.
    realInput: 0,
  };
}

/** Counts accumulating toward one scope's coverage. */
class CoverageTally {
  private fromTable = 0;
  private fromFallback = 0;
  private unpriced = 0;
  private readonly byCode = new Map<string, { notice: UnavailableNotice; records: number }>();

  add(record: PricedRecord): void {
    if (record.pricingSource === null) {
      this.unpriced += 1;
      const notice = costUnavailableNotice(record.unavailableReason);
      const seen = this.byCode.get(notice.code);
      if (seen === undefined) this.byCode.set(notice.code, { notice, records: 1 });
      else seen.records += 1;
      return;
    }
    if (record.pricingSource.kind === 'table') this.fromTable += 1;
    else this.fromFallback += 1;
  }

  result(): PricingCoverage {
    const reasons = [...this.byCode.values()]
      .map(({ notice, records }) => ({
        code: notice.code,
        label: notice.label,
        detail: notice.detail,
        severity: notice.severity,
        records,
      }))
      .sort((a, b) => b.records - a.records || a.code.localeCompare(b.code));
    return {
      summary: pricingSummaryFrom({
        fromTable: this.fromTable,
        fromFallback: this.fromFallback,
        unpriced: this.unpriced,
      }),
      reasons,
    };
  }
}

export interface PricingCoverageOptions {
  /** A reporting day to scope the second tally to, or `null`/absent for corpus only. */
  readonly date?: string | null;
  readonly proxy?: string;
}

/**
 * Read pricing coverage against the rate table as it stands now.
 *
 * Reads `request` and the two rate tables and writes nothing, so it is safe on
 * any read path.
 */
export function readPricingCoverage(db: DatabaseSync, options: PricingCoverageOptions = {}): PricingCoverageReport {
  const { date = null, proxy = CLAUDE_PROXY_ID } = options;
  const resolve = costResolverFor(db, proxy);
  // SAFETY: `COVERAGE_ROWS` is a literal in this module and selects exactly the
  // six columns `CoverageRow` names — `timestamp` and `model` are declared TEXT
  // and NOT NULL on `request`, and the four `used_*` are SQLite comparisons,
  // which yield integer 0 or 1 and never null. No column is a blob, so every
  // value is a string or a number as declared.
  const rows = db.prepare(COVERAGE_ROWS).all();

  const memo = new Map<string, PricedRecord>();
  const corpus = new CoverageTally();
  const day = date === null ? null : new CoverageTally();

  for (const raw of rows) {
    const row = toCoverageRow(raw);
    const key = `${row.model} ${row.usedInput}${row.usedOutput}${row.usedCacheWrite}${row.usedCacheRead}`;
    let record = memo.get(key);
    if (record === undefined) {
      record = resolve(standInTokens(row), row.model);
      memo.set(key, record);
    }
    corpus.add(record);
    if (day !== null && reportDay(row.timestamp) === date) day.add(record);
  }

  return {
    corpus: corpus.result(),
    day: day === null || date === null ? null : { date, ...day.result() },
  };
}
