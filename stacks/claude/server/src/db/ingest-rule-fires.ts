import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { type JsonInput, jsonField, jsonNumber, jsonString, numberField, parseJson, stringField } from '../json.js';

/**
 * Index `<logDir>/rule-fires.jsonl` into the `rule_fire` table.
 *
 * The file belongs to the sibling `my-command` repository: its workflow gates
 * append a row the first time each one refuses a call, and `/judge` appends one
 * through `my-command-tools rules fire` for a confirmed suggestion that shows a
 * prose rule being broken. Both write to `dirname($CLAUDE_PROXY_STORE)`, which is
 * this `logDir`. A `/judge` fire also carries `suggestion`, `bucket` and `thread`.
 *
 * - **The watermark is a byte offset.** The file is append-only, so a pass reads
 *   only the bytes past the `file_watermark` row's `bytes` and never re-parses
 *   what an earlier pass consumed. A torn final line is left unconsumed for the
 *   next pass, since the writer may still be mid-append.
 * - **A re-run never double-counts.** Each row is keyed on the byte offset of its
 *   line, so even a pass that re-reads consumed bytes upserts onto the rows it
 *   already wrote.
 * - **A file shorter than its watermark was replaced**, not appended to. The
 *   table is rebuilt from offset 0, and a file that is gone takes its rows with it.
 * - **A null model is filled from `session.model`.** A gate reads the model off
 *   the tail of a transcript, which can come back empty; the proxy's own session
 *   row knows it. Every pass retries the rows still null, because the session row
 *   is often ingested after the fire.
 */

/** The store's path relative to `logDir` — also its `file_watermark` key. */
export const STORE_PATH = 'rule-fires.jsonl';

/** The record format this file understands. A line declaring another is skipped. */
const FORMAT_VERSION = 1;

const NEWLINE = 0x0a;

export interface RuleFireIngestStats {
  /** Rows the table holds once this pass is done. */
  fires: number;
  /** Lines read this pass that became a row. */
  parsed: number;
  /** Complete lines read this pass that could not: malformed, missing `rule`/`at`, or another `v`. */
  skipped: number;
  /** Null models this pass filled from `session.model`. */
  filled: number;
  /** Rows dropped because the file was replaced or removed. */
  deleted: number;
}

interface FireRow {
  rule: string;
  at: string;
  model: string | null;
  sessionId: string | null;
  origin: string;
  suggestion: string | null;
  bucket: string | null;
  threadId: string | null;
}

/** A text column from a string or a number field; null for anything else, or an empty string. */
function text(value: JsonInput): string | null {
  const s = jsonString(value);
  if (s !== undefined) return s === '' ? null : s;
  const n = jsonNumber(value);
  return n === undefined ? null : String(n);
}

/** One line as a row, or null when it is not a fire this file can store. */
export function parseFireLine(line: string): FireRow | null {
  let record: JsonInput;
  try {
    record = parseJson(line);
  } catch {
    return null;
  }
  const v = numberField(record, 'v');
  if (v !== undefined && v !== FORMAT_VERSION) return null;
  const rule = stringField(record, 'rule');
  const at = stringField(record, 'at');
  if (!rule || !at) return null;
  return {
    rule,
    at,
    model: text(jsonField(record, 'model')),
    sessionId: text(jsonField(record, 'session')),
    origin: stringField(record, 'origin') || 'hook',
    suggestion: text(jsonField(record, 'suggestion')),
    bucket: text(jsonField(record, 'bucket')),
    threadId: text(jsonField(record, 'thread')),
  };
}

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** Run `work` in one transaction, so a part-way failure leaves the previous rows and watermark. */
function inTransaction(db: DatabaseSync, work: () => void): void {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function countRows(db: DatabaseSync, where = ''): number {
  // SAFETY: an aggregate with no GROUP BY always answers exactly one row, and `c` is
  // the only column in the select list.
  return (db.prepare(`SELECT count(*) c FROM rule_fire ${where}`).get() as { c: number }).c;
}

/** Drop every row and the watermark, returning how many rows went. */
function clearStore(db: DatabaseSync): number {
  const rows = countRows(db);
  db.prepare('DELETE FROM rule_fire').run();
  db.prepare('DELETE FROM file_watermark WHERE path = ?').run(STORE_PATH);
  return rows;
}

/** The bytes from `start` to `end` of `file`. */
async function readRange(file: string, start: number, end: number): Promise<Buffer> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Give each null model the one its session row names. A fire carrying a thread
 * id prefers that thread's row, since a subagent can run on another model than
 * its root; otherwise the session's root row, then its most recent one.
 *
 * The outer row is referenced only in each subquery's WHERE: SQLite before
 * 3.53 cannot resolve the UPDATE target from a correlated ORDER BY.
 */
function fillModels(db: DatabaseSync): number {
  const before = countRows(db, 'WHERE model IS NULL');
  if (before === 0) return 0;
  db.prepare(`
    UPDATE rule_fire SET model = COALESCE(
      (SELECT s.model FROM session s
        WHERE s.model IS NOT NULL AND s.thread_id = rule_fire.thread_id
        ORDER BY s.parent_thread_id IS NULL DESC, s.started DESC
        LIMIT 1),
      (SELECT s.model FROM session s
        WHERE s.model IS NOT NULL AND s.session_id = rule_fire.session_id
        ORDER BY s.parent_thread_id IS NULL DESC, s.started DESC
        LIMIT 1)
    )
    WHERE model IS NULL AND (session_id IS NOT NULL OR thread_id IS NOT NULL)
  `).run();
  return before - countRows(db, 'WHERE model IS NULL');
}

/**
 * Bring `rule_fire` level with `<logDir>/rule-fires.jsonl`. Safe to call
 * repeatedly: bytes already consumed are not re-read, and a row is keyed on
 * where its line starts. A file that is not there is the normal state on a
 * machine whose gates have never refused anything: zero rows, no error.
 */
export async function ingestRuleFires(db: DatabaseSync, logDir: string): Promise<RuleFireIngestStats> {
  const stats: RuleFireIngestStats = { fires: 0, parsed: 0, skipped: 0, filled: 0, deleted: 0 };
  const file = path.join(logDir, STORE_PATH);

  let size: number;
  let modified: string;
  try {
    const info = await stat(file);
    size = info.size;
    modified = info.mtime.toISOString();
  } catch (cause) {
    // Only a *missing* file means the rows are unbacked; any other error says
    // nothing about what is on disk, so it must not drop them.
    if (!isMissingFile(cause)) throw cause;
    inTransaction(db, () => {
      stats.deleted = clearStore(db);
    });
    return stats;
  }

  // SAFETY: this SELECT names exactly `bytes`, and `path` is the table's primary
  // key, so the answer is one row or none.
  const mark = db.prepare('SELECT bytes FROM file_watermark WHERE path = ?').get(STORE_PATH) as
    | { bytes: number }
    | undefined;
  let start = mark?.bytes ?? 0;
  if (size < start) {
    inTransaction(db, () => {
      stats.deleted = clearStore(db);
    });
    start = 0;
  }

  if (size > start) {
    const chunk = await readRange(file, start, size);
    // Only complete lines are consumed; a torn tail waits for its newline.
    const consumed = chunk.lastIndexOf(NEWLINE) + 1;
    if (consumed > 0) {
      const insert = db.prepare(`
        INSERT INTO rule_fire (byte_offset, rule, at, model, session_id, origin, suggestion, bucket, thread_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(byte_offset) DO UPDATE SET
          rule = excluded.rule, at = excluded.at,
          model = COALESCE(excluded.model, rule_fire.model),
          session_id = excluded.session_id, origin = excluded.origin,
          suggestion = excluded.suggestion, bucket = excluded.bucket, thread_id = excluded.thread_id
      `);
      inTransaction(db, () => {
        let lineStart = 0;
        while (lineStart < consumed) {
          const lineEnd = chunk.indexOf(NEWLINE, lineStart);
          const line = chunk.toString('utf8', lineStart, lineEnd);
          if (line.trim()) {
            const row = parseFireLine(line);
            if (row) {
              insert.run(
                start + lineStart,
                row.rule,
                row.at,
                row.model,
                row.sessionId,
                row.origin,
                row.suggestion,
                row.bucket,
                row.threadId,
              );
              stats.parsed += 1;
            } else {
              stats.skipped += 1;
            }
          }
          lineStart = lineEnd + 1;
        }
        db.prepare(`
          INSERT INTO file_watermark (path, bytes, modified, scanned_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            bytes = excluded.bytes, modified = excluded.modified, scanned_at = excluded.scanned_at
        `).run(STORE_PATH, start + consumed, modified, new Date().toISOString());
      });
    }
  }

  stats.filled = fillModels(db);
  stats.fires = countRows(db);
  return stats;
}
