import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageRecord } from '@claude-proxy/core';
import { openDb, resolveDbPath, SCHEMA_VERSION } from './open.js';

/**
 * Level two of the usage meters' per-day cache: one row per closed archived day,
 * so the parse a process did survives that process.
 *
 * `usage-history.ts` is level one — the per-day map it has always held. This file
 * answers the one question that map cannot: did an earlier process already read
 * this day. That is where a cold `/api/usage` used to go, and it went there 28
 * times, once per day of the learning span.
 *
 * `day-digest-store.ts` is the same shape for `/api/summary` and could not be
 * reused for this: it stores a *daily* `UsageDigest`, and a meter measuring a
 * five-hour window needs the requests inside the day, not a sum over it. So a row
 * here is the day's requests projected down to {@link UsageRecord} — the four
 * fields the meters read — which is what makes it small enough to be worth
 * keeping.
 *
 * A row is a **derived** value for a day that can no longer change, never a
 * source of truth. `logs/` still holds every sidecar, and
 * `rm logs/claude-proxy.db && pnpm --filter server ingest` still reconstructs
 * everything. See `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

/**
 * Bump when the projection would answer differently for the same sidecars — a
 * new field on {@link UsageRecord}, or a change to which requests a day's read
 * yields. Nothing else in the key notices that, and a row outliving such a change
 * would pin the old answer in place where the in-process map was cleared by the
 * restart. Stale revisions are pruned on open, so a bump costs one re-read per day.
 */
const USAGE_DAY_REVISION = 1;

/**
 * The schema version rides along because an ingest-shape migration re-reads the
 * corpus (those steps clear `ingest_watermark`), which can change what a
 * DB-backed read of an already-closed day contains.
 */
const REVISION = `${SCHEMA_VERSION}.${USAGE_DAY_REVISION}`;

/**
 * What makes two reads of "the same archived day" the same. The backing is in it
 * because the parity harness reads the same day both ways and the two must never
 * share a row — the same reason `readArchivedDayMemo`'s in-process key carries it.
 *
 * No `archiveDir`: this cache serves the usage route, which reads the archive
 * under `logDir` and never takes a relocated root.
 */
export interface StoredUsageDayKey {
  /** `SidecarSource.kind` — `'files'` or `'db'`. */
  backing: string;
  logDir: string;
  date: string;
}

/** One archived day as the meters need it. */
export interface StoredUsageDay {
  /**
   * The day's entries, one per file the read matched, in the order it read them.
   * A valid request is a {@link UsageRecord} carrying its `__file`; a file that
   * would not parse, or that is not an audit sidecar, keeps its `__file` and
   * nothing else — dropping it would understate `/api/usage`'s `meta.files`.
   */
  records: unknown[];
  parseErrors: number;
}

const SELECT = `
SELECT records, parse_errors FROM usage_day
WHERE backing = ? AND log_dir = ? AND date = ? AND revision = ?
`;

/**
 * `DO NOTHING` rather than an update: the key pins the day, the backing and every
 * revision that could change the answer, so a conflicting row already holds these
 * records.
 */
const INSERT = `
INSERT INTO usage_day (backing, log_dir, date, revision, records, parse_errors, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING
`;

/** One open connection per log directory, opened on first use. */
const handles = new Map<string, DatabaseSync>();

/**
 * The substrate for `logDir`, or `null` when there is none.
 *
 * The file is never *created* here: a read route must not leave a database behind
 * in a log directory that had none. A negative answer is deliberately not
 * remembered — `startSubstrate` may open the file after the first read went
 * through.
 */
function handleFor(logDir: string): DatabaseSync | null {
  const held = handles.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDb(logDir);
    // A revision bump orphans the rows it wrote — no key reaches them again.
    db.prepare('DELETE FROM usage_day WHERE revision <> ?').run(REVISION);
    handles.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * The day an earlier process stored for `key`, or `undefined`. Best-effort: any
 * failure reads as a miss, which costs the read it would have saved and nothing else.
 */
export function readStoredUsageDay(key: StoredUsageDayKey): StoredUsageDay | undefined {
  const db = handleFor(key.logDir);
  if (!db) return undefined;
  try {
    const row = db.prepare(SELECT).get(key.backing, key.logDir, key.date, REVISION) as
      | { records?: string; parse_errors?: number }
      | undefined;
    if (row?.records === undefined) return undefined;
    return { records: JSON.parse(row.records) as unknown[], parseErrors: row.parse_errors ?? 0 };
  } catch {
    return undefined;
  }
}

/**
 * Keep `day` for `key`. The caller has already decided the day is closed — see
 * `usage-history.ts` — so nothing here re-litigates that.
 */
export function storeUsageDay(key: StoredUsageDayKey, day: StoredUsageDay): void {
  const db = handleFor(key.logDir);
  if (!db) return;
  try {
    db.prepare(INSERT).run(
      key.backing,
      key.logDir,
      key.date,
      REVISION,
      JSON.stringify(day.records),
      day.parseErrors,
      new Date().toISOString(),
    );
  } catch {
    // A cache write that fails changes no answer.
  }
}

/**
 * Drop every stored row this process can reach and close the connections —
 * test-only, alongside `clearArchivedUsageCache`.
 */
export function clearStoredUsageDays(): void {
  for (const db of handles.values()) {
    try {
      db.exec('DELETE FROM usage_day');
    } catch {
      // Closing still has to happen.
    }
    db.close();
  }
  handles.clear();
}
