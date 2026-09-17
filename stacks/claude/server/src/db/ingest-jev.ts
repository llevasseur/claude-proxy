import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type JsonInput,
  type JsonObject,
  jsonBoolean,
  jsonNumber,
  jsonObject,
  jsonString,
  numberField,
  objectField,
  parseJson,
  stringArrayField,
  stringField,
} from '../json.js';

/**
 * Index a keep of recorded Jev calls into the `jev_session` and `jev_call` tables.
 *
 * The keep is written by a recording proxy in the sibling `my-command` repository
 * and lives **outside** this one, one directory per proxy run:
 *
 * ```
 * <keep>/20260917T143012-4f2a1b/
 *   session.json     what that run was
 *   serve.log        plain text, not JSON — ignored
 *   000001.json      one exchange, numbered in call order
 * ```
 *
 * Three things follow from the keep being someone else's directory:
 *
 * - **Its absence is not an error.** A machine that has never run the recording
 *   proxy has no keep, and this reports zero rather than throwing. Only a keep
 *   that *was* there and is now gone drops rows, matching `ingest-concepts.ts`.
 * - **The watermark is per file**, not per directory: a run's records are written
 *   one at a time while it is live, so a finished record never needs re-reading
 *   but the directory around it keeps changing. Each file gets a `file_watermark`
 *   row under `jev/<session>/<file>`, keyed on `bytes` + `modified` exactly as the
 *   concept store's single row is.
 * - **An unrecognised `v` is skipped, never guessed at.** The format version is 1;
 *   a record carrying anything else is counted and left alone, because a reader
 *   that does not know the shape cannot know which of its fields still mean what
 *   they used to. A skipped record still records its watermark, so it is not
 *   re-read every pass; the schema step that teaches this file a new version
 *   clears `jev/%` from `file_watermark` and the whole keep is re-derived, the way
 *   `CONCEPT_DETAIL` does it.
 */

/** The record format this file understands. Anything else is skipped. */
const FORMAT_VERSION = 1;

/** One exchange per file, zero-padded to six digits. `serve.log` and anything else is not one. */
const CALL_FILE_RE = /^\d{6}\.json$/;

/** The `file_watermark` key for one file of the keep. Namespaced, since the keep is not `logDir`. */
function watermarkKey(session: string, file: string): string {
  return `jev/${session}/${file}`;
}

/**
 * Where the keep is: `MY_COMMAND_JEV_RECORD_DIR` when set, else
 * `~/.my-command/jev-record/`. Neither is required to exist.
 */
export function resolveJevRecordDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MY_COMMAND_JEV_RECORD_DIR;
  return override ? path.resolve(override) : path.join(homedir(), '.my-command', 'jev-record');
}

export interface JevIngestStats {
  /** Proxy runs the keep holds. */
  sessions: number;
  /** Call rows the table holds once this pass is done. */
  calls: number;
  /** Records parsed this pass — new, or changed since their watermark was written. */
  parsed: number;
  /**
   * Records skipped **this pass** because their `v` is not 1, or because the file
   * would not parse into a usable record. A skip is not a failure; the count is
   * how a keep written by a newer proxy makes itself visible.
   */
  skipped: number;
  /** Rows dropped because their record is no longer on disk. */
  deleted: number;
}

function emptyJevStats(): JevIngestStats {
  return { sessions: 0, calls: 0, parsed: 0, skipped: 0, deleted: 0 };
}

interface JevStatements {
  insertSession: ReturnType<DatabaseSync['prepare']>;
  insertCall: ReturnType<DatabaseSync['prepare']>;
  deleteSession: ReturnType<DatabaseSync['prepare']>;
  deleteCall: ReturnType<DatabaseSync['prepare']>;
  watermark: ReturnType<DatabaseSync['prepare']>;
  dropWatermark: ReturnType<DatabaseSync['prepare']>;
}

function prepare(db: DatabaseSync): JevStatements {
  return {
    // Upsert, not insert-once: a live run's `session.json` gains `endedAt` and
    // `recorded` when the proxy stops cleanly.
    insertSession: db.prepare(`
      INSERT INTO jev_session (session, v, started_at, ended_at, endpoint, pid, host, port, url, health, recorded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session) DO UPDATE SET
        v = excluded.v, started_at = excluded.started_at, ended_at = excluded.ended_at,
        endpoint = excluded.endpoint, pid = excluded.pid, host = excluded.host, port = excluded.port,
        url = excluded.url, health = excluded.health, recorded = excluded.recorded
    `),
    // A record is written once and never revised, but the upsert keeps a re-ingest
    // after a watermark clear idempotent rather than a primary-key collision.
    insertCall: db.prepare(`
      INSERT INTO jev_call (
        session, id, v, started_at, ended_at, duration_ms, endpoint,
        method, path, model, request_bytes, question_count, questions, question_ids,
        status, ok, response_bytes, answer_count, answers, answered_ids, unanswered_ids,
        usage_input_tokens, usage_output_tokens, error_name, error_message
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(session, id) DO UPDATE SET
        v = excluded.v, started_at = excluded.started_at, ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms, endpoint = excluded.endpoint,
        method = excluded.method, path = excluded.path, model = excluded.model,
        request_bytes = excluded.request_bytes, question_count = excluded.question_count,
        questions = excluded.questions, question_ids = excluded.question_ids,
        status = excluded.status, ok = excluded.ok, response_bytes = excluded.response_bytes,
        answer_count = excluded.answer_count, answers = excluded.answers,
        answered_ids = excluded.answered_ids, unanswered_ids = excluded.unanswered_ids,
        usage_input_tokens = excluded.usage_input_tokens,
        usage_output_tokens = excluded.usage_output_tokens,
        error_name = excluded.error_name, error_message = excluded.error_message
    `),
    deleteSession: db.prepare('DELETE FROM jev_session WHERE session = ?'),
    deleteCall: db.prepare('DELETE FROM jev_call WHERE session = ? AND id = ?'),
    watermark: db.prepare(`
      INSERT INTO file_watermark (path, bytes, modified, scanned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        bytes = excluded.bytes, modified = excluded.modified, scanned_at = excluded.scanned_at
    `),
    dropWatermark: db.prepare('DELETE FROM file_watermark WHERE path = ?'),
  };
}

/** True when a failed `readdir`/`stat` says the path is not there; any other errno must rethrow. */
function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

/** What one `stat` contributes to a watermark comparison. */
interface FileMark {
  bytes: number;
  modified: string;
}

/** The file's `stat` as a watermark pair, or null when it is not there. */
async function markOf(file: string): Promise<FileMark | null> {
  try {
    const info = await stat(file);
    return { bytes: info.size, modified: info.mtime.toISOString() };
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
    return null;
  }
}

/** The recorded watermark for one key, or null when this file has never been read. */
function readMark(db: DatabaseSync, key: string): FileMark | null {
  // SAFETY: this SELECT names exactly `bytes` and `modified`, and `path` is the
  // table's primary key, so the answer is one row or none.
  const row = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(key) as
    | { bytes: number; modified: string }
    | undefined;
  return row ? { bytes: row.bytes, modified: row.modified } : null;
}

function sameMark(a: FileMark | null, b: FileMark | null): boolean {
  return a !== null && b !== null && a.bytes === b.bytes && a.modified === b.modified;
}

/** A nullable integer column: the field when the record wrote a number, null otherwise. */
function num(value: JsonInput): number | null {
  return jsonNumber(value) ?? null;
}

/** A nullable text column: the field when the record wrote a string, null otherwise. */
function str(value: JsonInput): string | null {
  return jsonString(value) ?? null;
}

/** A JSON column: the value re-serialized, or null for a field the record left null. */
function json(value: JsonObject | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Read a whole file as a parsed JSON document, or null when it is unreadable or malformed. */
async function readRecord(file: string): Promise<JsonInput> {
  try {
    return parseJson(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** True when the document declares the one format version this file understands. */
function isKnownVersion(record: JsonInput): boolean {
  return numberField(record, 'v') === FORMAT_VERSION;
}

/** Write one run's `session.json` row. */
function writeSession(st: JevStatements, session: string, record: JsonInput): void {
  const doc = jsonObject(record);
  st.insertSession.run(
    session,
    FORMAT_VERSION,
    stringField(record, 'startedAt') ?? '',
    str(doc?.endedAt),
    stringField(record, 'endpoint') ?? '',
    num(doc?.pid),
    str(doc?.host),
    num(doc?.port),
    str(doc?.url),
    str(doc?.health),
    num(doc?.recorded),
  );
}

/**
 * Write one exchange's row.
 *
 * Headers, bodies, `bodyText` and `state` are read from the record and
 * deliberately never written — see the table's note in `open.ts`. What a failed
 * call needs to be legible is here: the status, the two counts, and the transport
 * error's name and message.
 */
function writeCall(st: JevStatements, session: string, id: number, record: JsonInput): void {
  const doc = jsonObject(record);
  const request = objectField(record, 'request');
  const response = objectField(record, 'response');
  const usage = objectField(response, 'usage');
  const error = objectField(response, 'error');

  st.insertCall.run(
    session,
    id,
    FORMAT_VERSION,
    stringField(record, 'startedAt') ?? '',
    str(doc?.endedAt),
    num(doc?.durationMs),
    str(doc?.endpoint),
    str(request?.method),
    str(request?.path),
    str(request?.model),
    numberField(request, 'bytes') ?? 0,
    numberField(request, 'questionCount') ?? 0,
    json(jsonObject(request?.questions)),
    JSON.stringify(stringArrayField(request, 'questionIds')),
    num(response?.status),
    jsonBoolean(response?.ok) === true ? 1 : 0,
    numberField(response, 'bytes') ?? 0,
    numberField(response, 'answerCount') ?? 0,
    json(jsonObject(response?.answers)),
    JSON.stringify(stringArrayField(response, 'answeredIds')),
    JSON.stringify(stringArrayField(response, 'unansweredIds')),
    // Null rather than 0 for a response that reported no usage: an unknown cost is
    // not a free one, and the record is careful never to write it as zeroes.
    usage ? num(usage.input_tokens) : null,
    usage ? num(usage.output_tokens) : null,
    error ? str(error.name) : null,
    error ? str(error.message) : null,
  );
}

/** Every row of the two tables, dropped together — for a keep that is no longer on disk. */
function clearKeep(db: DatabaseSync, st: JevStatements): number {
  // SAFETY: this SELECT names exactly `session`, which is what the row type declares.
  const sessions = db.prepare('SELECT session FROM jev_session').all() as Array<{ session: string }>;
  for (const row of sessions) st.deleteSession.run(row.session);
  db.prepare("DELETE FROM file_watermark WHERE path LIKE 'jev/%'").run();
  return sessions.length;
}

/** The call ids already stored for one run. */
function knownCallIds(db: DatabaseSync, session: string): Set<number> {
  // SAFETY: this SELECT names exactly `id`, which is what the row type declares.
  const rows = db.prepare('SELECT id FROM jev_call WHERE session = ?').all(session) as Array<{ id: number }>;
  return new Set(rows.map((row) => row.id));
}

/** `000007.json` -> 7, for a record whose own `id` field is unusable. */
function idFromName(name: string): number | null {
  const parsed = Number(name.slice(0, 6));
  return Number.isInteger(parsed) ? parsed : null;
}

/** Ingest one run's directory, reconciling it with what is on disk. */
async function ingestSession(
  db: DatabaseSync,
  st: JevStatements,
  keep: string,
  session: string,
  stats: JevIngestStats,
): Promise<void> {
  const dir = path.join(keep, session);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    if (!isMissingFile(cause)) throw cause;
    return; // Vanished between the listing and the read; the next pass reconciles it.
  }

  const sessionFile = path.join(dir, 'session.json');
  const sessionMark = await markOf(sessionFile);
  // A directory with no `session.json` is not a proxy run — nothing to skip-count,
  // since there is no record there to have a version.
  if (!sessionMark) return;

  const sessionKey = watermarkKey(session, 'session.json');
  if (!sameMark(sessionMark, readMark(db, sessionKey))) {
    const record = await readRecord(sessionFile);
    if (!isKnownVersion(record)) {
      // An unreadable or newer-format `session.json` takes its whole run with it:
      // the calls beside it are keyed on a row this pass cannot write.
      stats.skipped += 1;
      db.exec('BEGIN');
      try {
        st.watermark.run(sessionKey, sessionMark.bytes, sessionMark.modified, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return;
    }
    db.exec('BEGIN');
    try {
      writeSession(st, session, record);
      st.watermark.run(sessionKey, sessionMark.bytes, sessionMark.modified, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // A run whose `session.json` was skipped on an earlier pass has no row, and its
  // calls cannot be written against one. `PRAGMA foreign_keys` would refuse them.
  // SAFETY: this SELECT names exactly `session`, and it is the table's primary key,
  // so the answer is one row or none.
  const row = db.prepare('SELECT session FROM jev_session WHERE session = ?').get(session) as
    | { session: string }
    | undefined;
  if (!row) return;

  stats.sessions += 1;

  const callNames = names.filter((n) => CALL_FILE_RE.test(n)).sort();
  const present = new Set<number>();

  for (const name of callNames) {
    const file = path.join(dir, name);
    const mark = await markOf(file);
    if (!mark) continue; // Vanished mid-pass.

    const nameId = idFromName(name);
    if (nameId !== null) present.add(nameId);

    const key = watermarkKey(session, name);
    if (sameMark(mark, readMark(db, key))) continue;

    const record = await readRecord(file);
    if (!isKnownVersion(record)) {
      stats.skipped += 1;
      db.exec('BEGIN');
      try {
        st.watermark.run(key, mark.bytes, mark.modified, new Date().toISOString());
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      continue;
    }

    // The record's own `id` is the sequence within the run and matches the
    // filename; the filename is the fallback for a record that lost it.
    const id = numberField(record, 'id') ?? nameId;
    if (id === null) {
      stats.skipped += 1;
      continue;
    }
    present.add(id);

    db.exec('BEGIN');
    try {
      writeCall(st, session, id, record);
      st.watermark.run(key, mark.bytes, mark.modified, new Date().toISOString());
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    stats.parsed += 1;
  }

  // Rows whose record left the directory — the keep is prunable like any other.
  const stale = [...knownCallIds(db, session)].filter((id) => !present.has(id));
  if (stale.length === 0) return;
  db.exec('BEGIN');
  try {
    for (const id of stale) {
      st.deleteCall.run(session, id);
      st.dropWatermark.run(watermarkKey(session, `${String(id).padStart(6, '0')}.json`));
      stats.deleted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * Bring the `jev_session` and `jev_call` tables level with the keep. Safe to call
 * repeatedly: an unchanged record is not re-read, and each write commits on its
 * own, so a part-way failure leaves what it finished for the next pass to resume
 * from.
 *
 * A keep that is not on disk is the normal state on a machine that has never run
 * the recording proxy: zero rows, no error.
 */
export async function ingestJevCalls(db: DatabaseSync, keep = resolveJevRecordDir()): Promise<JevIngestStats> {
  const stats = emptyJevStats();
  const st = prepare(db);

  let entries: string[];
  try {
    entries = await readdir(keep);
  } catch (cause) {
    // Only a *missing* keep means the rows are unbacked. Any other error says
    // nothing about what is on disk, so it must not drop the tables.
    if (!isMissingFile(cause)) throw cause;
    db.exec('BEGIN');
    try {
      stats.deleted = clearKeep(db, st);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return stats;
  }

  const sessions: string[] = [];
  for (const entry of entries.sort()) {
    try {
      if ((await stat(path.join(keep, entry))).isDirectory()) sessions.push(entry);
    } catch {
      // Vanished between the listing and the stat — nothing to ingest.
    }
  }

  // Runs whose directory left the keep. `ON DELETE CASCADE` takes their calls.
  const onDisk = new Set(sessions);
  // SAFETY: this SELECT names exactly `session`, which is what the row type declares.
  const stored = db.prepare('SELECT session FROM jev_session').all() as Array<{ session: string }>;
  db.exec('BEGIN');
  try {
    for (const row of stored) {
      if (onDisk.has(row.session)) continue;
      st.deleteSession.run(row.session);
      db.prepare('DELETE FROM file_watermark WHERE path LIKE ?').run(`jev/${row.session}/%`);
      stats.deleted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  for (const session of sessions) {
    await ingestSession(db, st, keep, session, stats);
  }

  // SAFETY: `count(*)` aliased to `c` is the whole select list, and an aggregate with
  // no GROUP BY always answers exactly one row.
  stats.calls = (db.prepare('SELECT count(*) c FROM jev_call').get() as { c: number }).c;
  return stats;
}
