import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type {
  CostUnavailableReason,
  PricedCost,
  ResolvedCalendarRange,
  SanitizedAuditSidecarV1,
  TodaySummary,
} from '@agent-proxy/codex-core';
import {
  aggregateToday,
  estimateUsageCost,
  formatReportDate,
  parseSanitizedAuditSidecar,
  selectByModels,
} from '@agent-proxy/codex-core';
import { RECORD_ADAPTER_VERSION, RECORD_HARNESS, RECORD_PROVIDER } from './record-stamp.ts';

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire('node:sqlite') as typeof import('node:sqlite');

const SCHEMA_VERSION = 4;

/**
 * The oldest stamped version this ladder can start from. 003 is a whole-schema
 * baseline rather than a delta, and no 001 or 002 file has ever existed here:
 * codex used to answer a version mismatch by deleting the store, so the
 * migrations that would have climbed out of 1 and 2 were never written. A
 * database stamped 1 or 2 therefore has no forward path and is refused, which
 * is the honest answer — ADR 0047 forbids resolving a mismatch by deletion,
 * and reconstructing two missing migrations from a schema nobody kept would be
 * a guess applied to somebody's corpus.
 */
const BASELINE_VERSION = 3;

const SCHEMA_V3 = readFileSync(new URL('../migrations/003-car-reprice.sql', import.meta.url), 'utf8');
const SCHEMA_V4 = readFileSync(new URL('../migrations/004-record-stamp.sql', import.meta.url), 'utf8');

interface VersionRow {
  readonly user_version: number;
}

interface CountRow {
  readonly count: number;
}

interface TimeRow {
  readonly ingested_at: string;
}

export interface HistoryRecord {
  readonly recordId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly requestId: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

export interface HistoryPage {
  readonly total: number;
  readonly records: readonly HistoryRecord[];
}

interface RecordRow {
  readonly record_id: string;
  readonly timestamp: string;
  readonly model: string;
  readonly endpoint: string;
  readonly response_status: number;
  readonly request_id: string | null;
  readonly input_tokens: number;
  readonly cached_input_tokens: number;
  readonly output_tokens: number;
  readonly reasoning_output_tokens: number;
  readonly total_tokens: number;
  readonly cost_amount_usd: string | null;
  readonly cost_catalogue_version: string | null;
  readonly cost_unavailable_reason: string | null;
  readonly sidecar_json: string;
}

function historyRecordFromRow(row: RecordRow): HistoryRecord {
  return Object.freeze({
    recordId: row.record_id,
    timestamp: row.timestamp,
    model: row.model,
    endpoint: row.endpoint,
    responseStatus: row.response_status,
    requestId: row.request_id,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    reasoningOutputTokens: row.reasoning_output_tokens,
    totalTokens: row.total_tokens,
    cost:
      row.cost_amount_usd === null
        ? null
        : Object.freeze({
            currency: 'USD' as const,
            amountUsd: row.cost_amount_usd,
            catalogueVersion: row.cost_catalogue_version ?? 'unknown',
          }),
    costUnavailableReason:
      row.cost_unavailable_reason === null ? null : (JSON.parse(row.cost_unavailable_reason) as CostUnavailableReason),
  });
}

function rangeBounds(range: ResolvedCalendarRange): Readonly<{ startMs: number; endMs: number }> {
  const endMs = range.endExclusive.getTime();
  return Object.freeze({ startMs: range.startInclusive?.getTime() ?? 0, endMs });
}

function inRange(timestamp: string, bounds: Readonly<{ startMs: number; endMs: number }>): boolean {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return false;
  return ms >= bounds.startMs && ms < bounds.endMs;
}

// A sidecar written before a model joined the pricing catalogue records `unknown-model`.
// The catalogue is retroactive: price the record from the model and usage it already
// carries. Sidecars stay untouched; the view is derived state.
function effectiveSidecar(sidecar: SanitizedAuditSidecarV1): SanitizedAuditSidecarV1 {
  if (sidecar.cost !== null || sidecar.costUnavailableReason?.code !== 'unknown-model') return sidecar;
  const priced = estimateUsageCost(sidecar.model, sidecar.usage);
  if (priced.cost === null) return sidecar;
  return Object.freeze({ ...sidecar, cost: priced.cost, costUnavailableReason: null });
}

export interface IngestHooks {
  readonly beforeWatermark?: () => void;
}

export class UsageDatabase {
  readonly path: string;
  readonly journalMode: string;
  readonly schemaVersion: number;
  private database: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = open(path);
    this.database.exec('PRAGMA foreign_keys = ON');
    try {
      migrate(this.database);
    } catch (error) {
      // Release the handle, and nothing else. The store stays exactly as it
      // was found — a refusal the operator can act on, not a loss.
      this.database.close();
      throw error;
    }
    // Set after the ladder, deliberately. `journal_mode = WAL` is persistent:
    // it rewrites the file header and creates the `-wal` and `-shm` sidecars.
    // Doing that before deciding whether the store can be migrated would
    // modify a database this build is about to refuse, which is the thing the
    // refusal is supposed to avoid.
    this.journalMode = String(this.database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? 'unknown');
    this.schemaVersion = userVersion(this.database);
  }

  ingest(filename: string, sidecar: SanitizedAuditSidecarV1, now: Date, hooks: IngestHooks = {}): boolean {
    const effective = effectiveSidecar(sidecar);
    const serialized = JSON.stringify(sidecar);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const watermarked = this.database.prepare('SELECT 1 FROM ingest_watermarks WHERE filename = ?').get(filename);
      if (watermarked) {
        this.database.exec('COMMIT');
        return false;
      }

      const existing = this.database
        .prepare('SELECT sidecar_json FROM usage_records WHERE record_id = ?')
        .get(sidecar.recordId) as unknown as Readonly<{ sidecar_json: string }> | undefined;
      let changed = false;
      if (existing) {
        if (existing.sidecar_json !== serialized) {
          throw new Error(`record ${sidecar.recordId} conflicts with an existing record`);
        }
      } else {
        this.database
          .prepare(
            `INSERT INTO usage_records (
               record_id, filename, event_timestamp, day_key, model, endpoint, response_status, request_id,
               input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
               cost_amount_usd, cost_catalogue_version, cost_unavailable_reason, sidecar_json,
               provider, harness, adapter_version
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sidecar.recordId,
            filename,
            sidecar.timestamp,
            formatReportDate(Date.parse(sidecar.timestamp), 'UTC'),
            sidecar.model,
            sidecar.endpoint,
            sidecar.responseStatus,
            sidecar.requestId,
            sidecar.usage.inputTokens,
            sidecar.usage.cachedInputTokens,
            sidecar.usage.outputTokens,
            sidecar.usage.reasoningOutputTokens,
            sidecar.usage.totalTokens,
            effective.cost?.amountUsd ?? null,
            effective.cost?.catalogueVersion ?? null,
            effective.costUnavailableReason === null ? null : JSON.stringify(effective.costUnavailableReason),
            serialized,
            // Materialised here rather than derived on the way out. Reading it
            // back is a column read, not an inference — which is the read-time
            // guessing ADR 0040 forbids.
            RECORD_PROVIDER,
            RECORD_HARNESS,
            RECORD_ADAPTER_VERSION,
          );
        changed = true;
      }

      hooks.beforeWatermark?.();
      this.database
        .prepare('INSERT INTO ingest_watermarks (filename, record_id, ingested_at) VALUES (?, ?, ?)')
        .run(filename, sidecar.recordId, now.toISOString());
      this.database.prepare('DELETE FROM rejected_sidecars WHERE filename = ?').run(filename);
      this.database.exec('COMMIT');
      return changed;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  reject(filename: string, reason: string, now: Date): void {
    this.database
      .prepare(
        `INSERT INTO rejected_sidecars (filename, reason, rejected_at)
         VALUES (?, ?, ?)
         ON CONFLICT(filename) DO UPDATE SET reason = excluded.reason, rejected_at = excluded.rejected_at`,
      )
      .run(filename, reason, now.toISOString());
  }

  history(range: ResolvedCalendarRange, models: readonly string[], limit: number, offset: number): HistoryPage {
    const bounds = rangeBounds(range);
    const rows = (
      this.database
        .prepare(
          `SELECT record_id, event_timestamp AS timestamp, model, endpoint, response_status, request_id,
                  input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens,
                  cost_amount_usd, cost_catalogue_version, cost_unavailable_reason, sidecar_json
           FROM usage_records
           ORDER BY event_timestamp DESC, record_id ASC`,
        )
        .all() as unknown as RecordRow[]
    ).filter((row) => inRange(row.timestamp, bounds));
    const matching = selectByModels(rows.map(historyRecordFromRow), models);
    return Object.freeze({
      total: matching.length,
      records: Object.freeze(matching.slice(offset, offset + limit)),
    });
  }

  sidecarsInRange(range: ResolvedCalendarRange, models: readonly string[]): readonly SanitizedAuditSidecarV1[] {
    const bounds = rangeBounds(range);
    const rows = (
      this.database
        .prepare('SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id')
        .all() as unknown as Readonly<{ sidecar_json: string }>[]
    )
      .map((row) => JSON.parse(row.sidecar_json) as SanitizedAuditSidecarV1)
      .map(effectiveSidecar)
      .filter((sidecar) => inRange(sidecar.timestamp, bounds));
    return selectByModels(rows, models);
  }

  summary(now: Date, reportTimezone: string): TodaySummary {
    const rows = this.database
      .prepare('SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id')
      .all() as unknown as Readonly<{ sidecar_json: string }>[];
    return aggregateToday(
      rows.map((row) => parseSanitizedAuditSidecar(effectiveSidecar(JSON.parse(row.sidecar_json)))),
      now,
      reportTimezone,
    );
  }

  diagnostics(): Readonly<{ lastSuccessfulIngest: string | null; rejectedSidecars: number; recordCount: number }> {
    const last = this.database
      .prepare('SELECT ingested_at FROM ingest_watermarks ORDER BY ingested_at DESC LIMIT 1')
      .get() as unknown as TimeRow | undefined;
    const rejected = this.database
      .prepare('SELECT COUNT(*) AS count FROM rejected_sidecars')
      .get() as unknown as CountRow;
    const records = this.database.prepare('SELECT COUNT(*) AS count FROM usage_records').get() as unknown as CountRow;
    return Object.freeze({
      lastSuccessfulIngest: last?.ingested_at ?? null,
      rejectedSidecars: rejected.count,
      recordCount: records.count,
    });
  }

  close(): void {
    this.database.close();
  }
}

function open(path: string): InstanceType<typeof DatabaseSync> {
  return new DatabaseSync(path);
}

function userVersion(database: InstanceType<typeof DatabaseSync>): number {
  return (database.prepare('PRAGMA user_version').get() as unknown as VersionRow).user_version;
}

function hasTables(database: InstanceType<typeof DatabaseSync>): boolean {
  // SAFETY: `COUNT(*)` answers exactly one row whose single column is the
  // integer aliased here, which is what `CountRow` declares.
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .get() as unknown as CountRow;
  return row.count > 0;
}

/**
 * Migrate forward, or refuse.
 *
 * **This function never deletes anything** — not the database, not its `-wal`,
 * not its `-shm`. It used to: a `user_version` mismatch closed the handle,
 * `rmSync`'d all three files and re-ran the whole schema, which is ADR 0028's
 * rebuild-on-mismatch. [ADR 0047](../../../../docs/adrs/0047-sqlite-substrate-with-forward-only-migrations.md)
 * supersedes 0028 and states that a mismatch is never resolved by deletion,
 * and [ADR 0048](../../../../docs/adrs/0048-deletion-policy-split-by-tier.md)
 * puts the record tier out of reach of any deleting operation. Removing that
 * branch is what made bumping the version safe: with it still in place, the
 * first open after the bump would have wiped the corpus.
 *
 * A version this build cannot reach is a loud refusal, on the reasoning that
 * an operator who is told can restore a backup, while one whose store was
 * silently rebuilt cannot.
 */
function migrate(database: InstanceType<typeof DatabaseSync>): void {
  const from = userVersion(database);
  if (from === SCHEMA_VERSION) return;

  if (from > SCHEMA_VERSION) {
    throw new Error(
      `database schema version ${from} is newer than this build understands (${SCHEMA_VERSION}); ` +
        'upgrade the server rather than downgrading the store',
    );
  }
  if (from === 0 && hasTables(database)) {
    throw new Error('database carries tables but no schema version; refusing to migrate an unrecognized store');
  }
  if (from !== 0 && from < BASELINE_VERSION) {
    throw new Error(
      `database schema version ${from} predates the oldest migration this build carries (${BASELINE_VERSION}); ` +
        'no forward path exists, and the store has been left untouched',
    );
  }

  // One transaction, so a failure part-way up the ladder leaves the stamped
  // version and the schema agreeing with each other.
  database.exec('BEGIN IMMEDIATE');
  try {
    if (from < 3) database.exec(SCHEMA_V3);
    if (from < 4) database.exec(SCHEMA_V4);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
