import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CostUnavailableReason,
  PaginatedHistoryRecords,
  PricedCost,
  ResolvedCalendarRange,
  SanitizedAuditSidecarV1,
  TodaySummary,
  UsageTotals,
} from "@ox-alpha-proxy/core";
import {
  aggregateToday,
  paginateHistoryRecords,
  parseSanitizedAuditSidecar,
  selectByModels,
} from "@ox-alpha-proxy/core";

const SCHEMA_VERSION = 1;
const MIGRATION = `
CREATE TABLE usage_records (
  record_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  event_timestamp TEXT NOT NULL,
  sidecar_json TEXT NOT NULL
);

CREATE INDEX usage_records_timestamp_idx
  ON usage_records (event_timestamp);

CREATE TABLE ingest_watermarks (
  filename TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  ingested_at TEXT NOT NULL
);

CREATE TABLE rejected_sidecars (
  filename TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  rejected_at TEXT NOT NULL
);

PRAGMA user_version = 1;
`;

interface VersionRow {
  readonly user_version: number;
}

interface JsonRow {
  readonly sidecar_json: string;
}

interface CountRow {
  readonly count: number;
}

interface TimeRow {
  readonly ingested_at: string;
}

interface ExistingRecordRow {
  readonly filename: string;
  readonly sidecar_json: string;
}

export interface IngestHooks {
  readonly beforeWatermark?: () => void;
}

// ADR 0015: the listing re-renders exactly the sanitized sidecar fields already
// stored, plus requestId; no new data crosses the privacy boundary.
export interface HistoryRecordView {
  readonly recordId: string;
  readonly timestamp: string;
  readonly model: string;
  readonly endpoint: string;
  readonly responseStatus: number;
  readonly requestId: string | null;
  readonly usage: UsageTotals;
  readonly cost: PricedCost | null;
  readonly costUnavailableReason: CostUnavailableReason | null;
}

function inRange(timestamp: string, range: ResolvedCalendarRange): boolean {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return false;
  return ms >= (range.startInclusive?.getTime() ?? 0) && ms < range.endExclusive.getTime();
}

export class UsageDatabase {
  readonly path: string;
  readonly journalMode: string;
  readonly schemaVersion: number;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.journalMode = String(
      this.database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode ?? "unknown",
    );
    const version = (this.database.prepare("PRAGMA user_version").get() as unknown as VersionRow)
      .user_version;
    if (version === 0) this.database.exec(MIGRATION);
    this.schemaVersion = (
      this.database.prepare("PRAGMA user_version").get() as unknown as VersionRow
    ).user_version;
    if (this.schemaVersion !== SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`unsupported database schema version ${this.schemaVersion}`);
    }
  }

  ingest(
    filename: string,
    sidecar: SanitizedAuditSidecarV1,
    now: Date,
    hooks: IngestHooks = {},
  ): boolean {
    const serialized = JSON.stringify(sidecar);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const watermarked = this.database
        .prepare("SELECT 1 FROM ingest_watermarks WHERE filename = ?")
        .get(filename);
      if (watermarked) {
        this.database.exec("COMMIT");
        return false;
      }

      const existing = this.database
        .prepare("SELECT filename, sidecar_json FROM usage_records WHERE record_id = ?")
        .get(sidecar.recordId) as unknown as ExistingRecordRow | undefined;
      let changed = false;
      if (existing) {
        if (existing.sidecar_json !== serialized) {
          throw new Error(`record ${sidecar.recordId} conflicts with ${existing.filename}`);
        }
      } else {
        this.database
          .prepare(
            "INSERT INTO usage_records (record_id, filename, event_timestamp, sidecar_json) VALUES (?, ?, ?, ?)",
          )
          .run(sidecar.recordId, filename, sidecar.timestamp, serialized);
        changed = true;
      }

      hooks.beforeWatermark?.();
      this.database
        .prepare(
          "INSERT INTO ingest_watermarks (filename, record_id, ingested_at) VALUES (?, ?, ?)",
        )
        .run(filename, sidecar.recordId, now.toISOString());
      this.database.prepare("DELETE FROM rejected_sidecars WHERE filename = ?").run(filename);
      this.database.exec("COMMIT");
      return changed;
    } catch (error) {
      this.database.exec("ROLLBACK");
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

  // Newest first with recordId as the deterministic tiebreaker (ADR 0015);
  // pagination rides on core's paginateHistoryRecords so page shapes match.
  history(
    range: ResolvedCalendarRange,
    models: readonly string[],
    limit: number | null,
    offset: number,
  ): PaginatedHistoryRecords {
    const rows = this.database
      .prepare(
        "SELECT sidecar_json FROM usage_records ORDER BY event_timestamp DESC, record_id ASC",
      )
      .all() as unknown as JsonRow[];
    const matching = rows
      .map((row) => parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)))
      .filter((sidecar) => inRange(sidecar.timestamp, range));
    const selected = selectByModels(matching, models);
    return paginateHistoryRecords(
      selected.map(
        (sidecar): HistoryRecordView => ({
          recordId: sidecar.recordId,
          timestamp: sidecar.timestamp,
          model: sidecar.model,
          endpoint: sidecar.endpoint,
          responseStatus: sidecar.responseStatus,
          requestId: sidecar.requestId,
          usage: Object.freeze({ ...sidecar.usage }),
          cost: sidecar.cost,
          costUnavailableReason: sidecar.costUnavailableReason,
        }),
      ),
      limit,
      offset,
    );
  }

  sidecarsInRange(
    range: ResolvedCalendarRange,
    models: readonly string[],
  ): readonly SanitizedAuditSidecarV1[] {
    const rows = this.database
      .prepare("SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id")
      .all() as unknown as JsonRow[];
    return selectByModels(
      rows
        .map((row) => parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)))
        .filter((sidecar) => inRange(sidecar.timestamp, range)),
      models,
    );
  }

  // Every stored sidecar in chronological order; windowed meters filter by
  // their own spans.
  allSidecars(): readonly SanitizedAuditSidecarV1[] {
    const rows = this.database
      .prepare("SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id")
      .all() as unknown as JsonRow[];
    return rows.map((row) => parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)));
  }

  summary(now: Date, reportTimezone: string): TodaySummary {
    const rows = this.database
      .prepare("SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id")
      .all() as unknown as JsonRow[];
    return aggregateToday(
      rows.map((row) => parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json))),
      now,
      reportTimezone,
    );
  }

  diagnostics(): Readonly<{
    lastSuccessfulIngest: string | null;
    rejectedSidecars: number;
    recordCount: number;
  }> {
    const last = this.database
      .prepare("SELECT ingested_at FROM ingest_watermarks ORDER BY ingested_at DESC LIMIT 1")
      .get() as unknown as TimeRow | undefined;
    const rejected = this.database
      .prepare("SELECT COUNT(*) AS count FROM rejected_sidecars")
      .get() as unknown as CountRow;
    const records = this.database
      .prepare("SELECT COUNT(*) AS count FROM usage_records")
      .get() as unknown as CountRow;
    return Object.freeze({
      lastSuccessfulIngest: last?.ingested_at ?? null,
      rejectedSidecars: rejected.count,
      recordCount: records.count,
    });
  }

  listRejected(): ReadonlyArray<
    Readonly<{ filename: string; reason: string; rejectedAt: string }>
  > {
    const rows = this.database
      .prepare(
        "SELECT filename, reason, rejected_at FROM rejected_sidecars ORDER BY rejected_at DESC, filename",
      )
      .all() as unknown as Array<{ filename: string; reason: string; rejected_at: string }>;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({ filename: row.filename, reason: row.reason, rejectedAt: row.rejected_at }),
      ),
    );
  }

  allWatermarks(): ReadonlyArray<Readonly<{ filename: string; recordId: string }>> {
    const rows = this.database
      .prepare("SELECT filename, record_id FROM ingest_watermarks ORDER BY filename")
      .all() as unknown as Array<{ filename: string; record_id: string }>;
    return rows.map((row) => Object.freeze({ filename: row.filename, recordId: row.record_id }));
  }

  hasRecord(recordId: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM usage_records WHERE record_id = ?").get(recordId) !==
      undefined
    );
  }

  hasWatermark(filename: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM ingest_watermarks WHERE filename = ?").get(filename) !==
      undefined
    );
  }

  close(): void {
    this.database.close();
  }
}
