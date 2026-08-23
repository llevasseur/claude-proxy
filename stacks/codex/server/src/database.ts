import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type {
  CostUnavailableReason,
  PricedCost,
  ResolvedCalendarRange,
  SanitizedAuditSidecarV1,
  TodaySummary,
} from '@codex-proxy/core';
import {
  aggregateToday,
  estimateUsageCost,
  formatReportDate,
  parseSanitizedAuditSidecar,
  selectByModels,
} from '@codex-proxy/core';

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire('node:sqlite') as typeof import('node:sqlite');

const SCHEMA_VERSION = 3;
const MIGRATION = readFileSync(new URL('../migrations/003-car-reprice.sql', import.meta.url), 'utf8');

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
    this.journalMode = String(this.database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? 'unknown');
    const version = userVersion(this.database);
    if (version !== SCHEMA_VERSION) {
      this.database.close();
      if (path !== ':memory:') for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
      this.database = open(path);
      this.database.exec(MIGRATION);
    }
    this.schemaVersion = userVersion(this.database);
    if (this.schemaVersion !== SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`unsupported database schema version ${this.schemaVersion}`);
    }
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
               cost_amount_usd, cost_catalogue_version, cost_unavailable_reason, sidecar_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
