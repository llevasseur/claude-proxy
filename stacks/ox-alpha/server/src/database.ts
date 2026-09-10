import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CostUnavailableReason,
  PaginatedHistoryRecords,
  PricedCost,
  ResolvedCalendarRange,
  SanitizedAuditSidecarV1,
  TodaySummary,
  UsageTotals,
} from '@agent-proxy/ox-core';
import {
  aggregateToday,
  paginateHistoryRecords,
  parseSanitizedAuditSidecar,
  selectByModels,
} from '@agent-proxy/ox-core';

/**
 * Schema version, tracked in `PRAGMA user_version`. Bump it and add a `SCHEMA_Vn`
 * step to the ladder in `migrate` — never edit an existing step, because a store
 * already past it will never run it again.
 *
 * This number means something only inside *this* store. There is no global schema
 * version in this repository: claude is at 22 and codex at 3, on schemas that share
 * not one table with these three, and comparing across them is meaningless. See
 * `docs/adrs/0061-three-schemas-three-ladders-one-contract.md`.
 */
const SCHEMA_VERSION = 2;

/**
 * The provenance this store stamps onto every record it accepts.
 *
 * These are ox's own adapter identity rather than anything read off the wire, so
 * they are constants. `docs/adrs/0040-three-providers-and-three-harnesses.md` pairs
 * Ox Alpha with the opencode harness, and neither value is ever derived from the
 * other — that record forbids exactly that inference, which is why these are three
 * separate constants and not one lookup.
 *
 * **They are literals rather than imports, and that is forced.** The vocabulary they
 * fill — `ProviderId`, `HarnessId` and the four-field `RecordStamp` — is declared in
 * `stacks/claude/core/src/adapter-seam.ts`, which this package cannot reach: every
 * core in this repository is dependency-free, and ox's server depends on
 * `@agent-proxy/ox-core` alone. So the values cross the seam as data, the same shape
 * campaign ticket 02 settled on for claude's proxy, which writes its sidecar header
 * as literals for the same reason.
 */
const RECORD_PROVIDER = 'ox-alpha';
const RECORD_HARNESS = 'opencode';
const RECORD_ADAPTER_VERSION = 1;

/** The provenance stamp this store writes, exposed so tests can pin it. */
export const OX_RECORD_STAMP = Object.freeze({
  provider: RECORD_PROVIDER,
  harness: RECORD_HARNESS,
  adapterVersion: RECORD_ADAPTER_VERSION,
});

const SCHEMA_V1 = `
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
`;

/**
 * Materialise the four provenance fields onto `usage_records`.
 *
 * `sidecar_json` stays the source of truth; these columns are a projection of it
 * written once, at ingest. The `UPDATE` backfills rows already stored at version 1,
 * reading each blob exactly once here rather than leaving the columns null — a
 * one-time read at migration time, not a read path, so the rule the columns exist to
 * enforce is untouched and every row is stamped from the moment this step lands.
 *
 * The columns are nullable because SQLite's `ALTER TABLE` cannot add a `NOT NULL`
 * column without a `DEFAULT`, and a default is the wrong answer here: it would
 * silently stamp a row whose ingest failed to say what produced it, which is the one
 * failure these columns exist to make visible. `ingest` writes all four on every
 * insert instead, and a test pins that.
 */
const SCHEMA_V2 = `
ALTER TABLE usage_records ADD COLUMN provider TEXT;
ALTER TABLE usage_records ADD COLUMN harness TEXT;
ALTER TABLE usage_records ADD COLUMN model TEXT;
ALTER TABLE usage_records ADD COLUMN adapter_version INTEGER;

UPDATE usage_records
   SET provider = '${RECORD_PROVIDER}',
       harness = '${RECORD_HARNESS}',
       adapter_version = ${RECORD_ADAPTER_VERSION},
       model = json_extract(sidecar_json, '$.model');

CREATE INDEX usage_records_model_idx
  ON usage_records (model);
`;

interface VersionRow {
  readonly user_version: number;
}

interface JsonRow {
  readonly sidecar_json: string;
}

/**
 * A row read for its `model` **column** rather than for the model inside its blob.
 *
 * Non-null by construction: `ingest` stamps the column on every insert and the
 * 1 → 2 step backfilled every row that predates it.
 */
interface ModelJsonRow {
  readonly model: string;
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

function userVersion(database: DatabaseSync): number {
  // SAFETY: `PRAGMA user_version` answers exactly one row with exactly one column,
  // which SQLite names `user_version` — which is what `VersionRow` declares.
  return (database.prepare('PRAGMA user_version').get() as unknown as VersionRow).user_version;
}

/**
 * The forward-only ladder, in the shape `stacks/claude/server/src/db/open.ts` uses:
 * read where the store is, run every step above that point in order, then stamp the
 * new version. Per
 * `docs/adrs/0047-sqlite-substrate-with-forward-only-migrations.md` the ladder is
 * per-database — this one is ox's and answers to nothing else's version number.
 *
 * **A version this ladder cannot reach is refused loudly, and never repaired by
 * deleting anything.** A store from a future writer, or one carrying a nonsense
 * `user_version`, throws and leaves every byte where it was:
 * `docs/adrs/0048-deletion-policy-split-by-tier.md` forbids deleting the record tier
 * by any operation, and a version mismatch is not an exception to that. ox already
 * behaved this way before it had a ladder — unlike codex, it never deleted on
 * mismatch — and keeping that is the point of doing this half first.
 *
 * The steps run inside one transaction so a failure part-way leaves the store at its
 * old version rather than half-migrated. Without it a store whose `ADD COLUMN`
 * landed but whose backfill did not would keep its old `user_version` and re-run the
 * same `ADD COLUMN` on every subsequent open, failing on the duplicate column
 * forever.
 */
function migrate(database: DatabaseSync): number {
  const from = userVersion(database);
  if (from === SCHEMA_VERSION) return from;
  if (!Number.isInteger(from) || from < 0 || from > SCHEMA_VERSION) {
    throw new Error(`unsupported database schema version ${from}`);
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    if (from < 1) database.exec(SCHEMA_V1);
    if (from < 2) database.exec(SCHEMA_V2);
    // `PRAGMA user_version` takes no bind parameters, hence the interpolation.
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return userVersion(database);
}

export class UsageDatabase {
  readonly path: string;
  readonly journalMode: string;
  readonly schemaVersion: number;
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON');
    this.journalMode = String(this.database.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode ?? 'unknown');
    try {
      this.schemaVersion = migrate(this.database);
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  ingest(filename: string, sidecar: SanitizedAuditSidecarV1, now: Date, hooks: IngestHooks = {}): boolean {
    const serialized = JSON.stringify(sidecar);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const watermarked = this.database.prepare('SELECT 1 FROM ingest_watermarks WHERE filename = ?').get(filename);
      if (watermarked) {
        this.database.exec('COMMIT');
        return false;
      }

      const existing = this.database
        .prepare('SELECT filename, sidecar_json FROM usage_records WHERE record_id = ?')
        .get(sidecar.recordId) as unknown as ExistingRecordRow | undefined;
      let changed = false;
      if (existing) {
        if (existing.sidecar_json !== serialized) {
          throw new Error(`record ${sidecar.recordId} conflicts with ${existing.filename}`);
        }
      } else {
        // The four provenance columns are written here and only here, as a
        // projection of the already-parsed sidecar.
        this.database
          .prepare(
            `INSERT INTO usage_records
               (record_id, filename, event_timestamp, sidecar_json, provider, harness, model, adapter_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            sidecar.recordId,
            filename,
            sidecar.timestamp,
            serialized,
            RECORD_PROVIDER,
            RECORD_HARNESS,
            sidecar.model,
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

  // Newest first with recordId as the deterministic tiebreaker (ADR 0015);
  // pagination rides on core's paginateHistoryRecords so page shapes match.
  history(
    range: ResolvedCalendarRange,
    models: readonly string[],
    limit: number | null,
    offset: number,
  ): PaginatedHistoryRecords {
    // `model` comes from the column, not the blob — the outcome ADR 0061 requires
    // of every read path. The blob still supplies everything else this view shows.
    // SAFETY: the two selected columns are exactly the two `ModelJsonRow` declares.
    const rows = this.database
      .prepare('SELECT model, sidecar_json FROM usage_records ORDER BY event_timestamp DESC, record_id ASC')
      .all() as unknown as ModelJsonRow[];
    const matching = rows
      .map((row) => ({ model: row.model, sidecar: parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)) }))
      .filter((entry) => inRange(entry.sidecar.timestamp, range));
    const selected = selectByModels(matching, models);
    return paginateHistoryRecords(
      selected.map(
        ({ model, sidecar }): HistoryRecordView => ({
          recordId: sidecar.recordId,
          timestamp: sidecar.timestamp,
          model,
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

  sidecarsInRange(range: ResolvedCalendarRange, models: readonly string[]): readonly SanitizedAuditSidecarV1[] {
    // Model selection reads the column, for the reason given in `history`.
    // SAFETY: the two selected columns are exactly the two `ModelJsonRow` declares.
    const rows = this.database
      .prepare('SELECT model, sidecar_json FROM usage_records ORDER BY event_timestamp, record_id')
      .all() as unknown as ModelJsonRow[];
    const matching = rows
      .map((row) => ({ model: row.model, sidecar: parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)) }))
      .filter((entry) => inRange(entry.sidecar.timestamp, range));
    return selectByModels(matching, models).map((entry) => entry.sidecar);
  }

  // Every stored sidecar in chronological order; windowed meters filter by
  // their own spans.
  //
  // This and `summary` hand whole sidecars to core's aggregation, which reads the
  // payload — model included — as the payload rather than as provenance. That is the
  // blob acting as the source of truth it is declared to be, not a read path
  // reconstituting identity from it: `model` selects and renders from the column
  // wherever this server answers *with* a model, and `migrationPreservesRows` pins
  // that the two can never disagree.
  allSidecars(): readonly SanitizedAuditSidecarV1[] {
    const rows = this.database
      .prepare('SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id')
      .all() as unknown as JsonRow[];
    return rows.map((row) => parseSanitizedAuditSidecar(JSON.parse(row.sidecar_json)));
  }

  summary(now: Date, reportTimezone: string): TodaySummary {
    const rows = this.database
      .prepare('SELECT sidecar_json FROM usage_records ORDER BY event_timestamp, record_id')
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

  listRejected(): ReadonlyArray<Readonly<{ filename: string; reason: string; rejectedAt: string }>> {
    const rows = this.database
      .prepare('SELECT filename, reason, rejected_at FROM rejected_sidecars ORDER BY rejected_at DESC, filename')
      .all() as unknown as Array<{ filename: string; reason: string; rejected_at: string }>;
    return Object.freeze(
      rows.map((row) => Object.freeze({ filename: row.filename, reason: row.reason, rejectedAt: row.rejected_at })),
    );
  }

  allWatermarks(): ReadonlyArray<Readonly<{ filename: string; recordId: string }>> {
    const rows = this.database
      .prepare('SELECT filename, record_id FROM ingest_watermarks ORDER BY filename')
      .all() as unknown as Array<{ filename: string; record_id: string }>;
    return rows.map((row) => Object.freeze({ filename: row.filename, recordId: row.record_id }));
  }

  hasRecord(recordId: string): boolean {
    return this.database.prepare('SELECT 1 FROM usage_records WHERE record_id = ?').get(recordId) !== undefined;
  }

  hasWatermark(filename: string): boolean {
    return this.database.prepare('SELECT 1 FROM ingest_watermarks WHERE filename = ?').get(filename) !== undefined;
  }

  close(): void {
    this.database.close();
  }
}
