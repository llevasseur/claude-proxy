import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { ContextDayAggregate } from '@claude-proxy/core';
import { openDb, resolveDbPath, SCHEMA_VERSION } from './open.js';

/**
 * Level two of the context route's per-day cache: one row per closed reporting
 * day, so the aggregate a process computed survives that process.
 *
 * `context-day-memo.ts` is level one — the map held for the process lifetime.
 * This file answers the one question that map cannot: did an earlier process
 * already reduce this day. That is where a cold `/api/context?days=30` used to
 * go, reading every sidecar in the window to draw a table of 25 rows.
 *
 * `day-digest-store.ts` beside it is the same shape for `/api/summary` and could
 * not be reused: it stores a `UsageDigest`, which carries none of the context
 * facts — no `realInput` order statistics, no per-thread peak, no drill-down
 * handle. So a row here is the day's own {@link ContextDayAggregate}: the sums,
 * the sorted token counts a median needs, the day's largest requests, and the
 * day's slice of the thread index.
 *
 * A row is a **derived** value for a day that can no longer change, never a
 * source of truth: `logs/` still holds every sidecar, and
 * `rm logs/claude-proxy.db && pnpm --filter server ingest` reconstructs
 * everything. See `docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md`.
 */

/**
 * Bump when {@link ContextDayAggregate} would come out differently for the same
 * sidecars — a new field on it or on a thread row, a changed tie-break, a
 * different `topN`. Nothing else in the key notices that, and a row outliving
 * such a change would pin the old answer in place. Stale revisions are pruned on
 * open, so a bump costs one recomputation per day.
 */
const CONTEXT_DAY_REVISION = 1;

/**
 * The schema version rides along because an ingest-shape migration re-reads the
 * corpus (those steps clear `ingest_watermark`), which can change what a
 * DB-backed read of an already-closed day contains.
 */
const REVISION = `${SCHEMA_VERSION}.${CONTEXT_DAY_REVISION}`;

/**
 * What makes two reads of "the same reporting day" the same. The backing is in it
 * because the parity harness reads the same day both ways and the two must never
 * share a row.
 *
 * No `archiveDir`: `buildContext` reads the archive under `logDir` and never
 * takes a relocated root, the same reason `usage-day-store.ts` omits it.
 */
export interface StoredContextDayKey {
  /** `SidecarSource.kind` — `'files'` or `'db'`. */
  backing: string;
  logDir: string;
  date: string;
}

/** One reporting day as the context route needs it, counts included. */
export interface StoredContextDay {
  aggregate: ContextDayAggregate;
  /** `*.audit.json` files the day matched, so the route's `meta.files` is a sum. */
  files: number;
  parseErrors: number;
}

const SELECT = `
SELECT aggregate, files, parse_errors FROM context_day
WHERE backing = ? AND log_dir = ? AND date = ? AND revision = ?
`;

/**
 * `DO NOTHING` rather than an update: the key pins the day, the backing and every
 * revision that could change the answer, so a conflicting row already holds this
 * aggregate.
 */
const INSERT = `
INSERT INTO context_day (backing, log_dir, date, revision, aggregate, files, parse_errors, computed_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    db.prepare('DELETE FROM context_day WHERE revision <> ?').run(REVISION);
    handles.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * The day an earlier process stored for `key`, or `undefined`. Best-effort: any
 * failure reads as a miss, costing the read it would have saved and nothing else.
 */
export function readStoredContextDay(key: StoredContextDayKey): StoredContextDay | undefined {
  const db = handleFor(key.logDir);
  if (!db) return undefined;
  try {
    // SAFETY: `SELECT` names exactly the three columns below, and every column of
    // `context_day`'s primary key is bound above, so the answer is one row or none.
    const row = db.prepare(SELECT).get(key.backing, key.logDir, key.date, REVISION) as
      | { aggregate?: string; files?: number; parse_errors?: number }
      | undefined;
    if (row?.aggregate === undefined) return undefined;
    // SAFETY: `storeContextDay` below is the column's only writer and stores
    // `JSON.stringify(day.aggregate)`; `REVISION` is in the key, so a row written
    // under an older aggregate shape is never reached by this read.
    const aggregate = JSON.parse(row.aggregate) as ContextDayAggregate;
    return { aggregate, files: row.files ?? 0, parseErrors: row.parse_errors ?? 0 };
  } catch {
    return undefined;
  }
}

/**
 * Keep `day` for `key`. The caller has already decided the day is closed and
 * stable — see `cacheContextDay` — so nothing here re-litigates that.
 */
export function storeContextDay(key: StoredContextDayKey, day: StoredContextDay): void {
  const db = handleFor(key.logDir);
  if (!db) return;
  try {
    db.prepare(INSERT).run(
      key.backing,
      key.logDir,
      key.date,
      REVISION,
      JSON.stringify(day.aggregate),
      day.files,
      day.parseErrors,
      new Date().toISOString(),
    );
  } catch {
    // A cache write that fails changes no answer.
  }
}

/**
 * Drop every stored row this process can reach and close the connections —
 * test-only, alongside `clearContextDayMemo`.
 */
export function clearStoredContextDays(): void {
  for (const db of handles.values()) {
    try {
      db.exec('DELETE FROM context_day');
    } catch {
      // Closing still has to happen.
    }
    db.close();
  }
  handles.clear();
}
