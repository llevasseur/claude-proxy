import { readdir, readFile, stat } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isAuditSidecar, type AuditSidecar } from "@claude-proxy/core";
import { ingestSessions } from "./ingest-sessions.js";

/**
 * Fill the substrate from `logs/`, and keep it filled. Runs unattended on server
 * start and on every filesystem event, so:
 *
 * - **Idempotent.** Rows are keyed on the sidecar's filename stem and inserted
 *   with `ON CONFLICT DO NOTHING`.
 * - **Watermarked.** Each scanned directory records what it last saw, so a
 *   half-finished pass resumes and an untouched archived day is skipped whole.
 *
 * The proxy never writes here; the server does all of the ingesting.
 */

/** The live log directory, as a `source_dir` value. Archived days are `archive/<YYYY-MM-DD>`. */
const LIVE = "";

const AUDIT_SUFFIX = ".audit.json";

export interface IngestStats {
  /** Directories examined (live plus each archived day present on disk). */
  dirs: number;
  /** Directories skipped because their listing still matched the watermark. */
  dirsSkipped: number;
  inserted: number;
  /** Rows dropped because their file is no longer on disk. */
  deleted: number;
  /** Files that were on disk but could not become a `request` row. */
  skipped: number;
  /** Session transcripts on disk. */
  sessions: number;
  /** Transcripts parsed this pass — new, or appended to since the last one. */
  sessionsParsed: number;
}

function emptyStats(): IngestStats {
  return { dirs: 0, dirsSkipped: 0, inserted: 0, deleted: 0, skipped: 0, sessions: 0, sessionsParsed: 0 };
}

/** Absolute path of a `source_dir`. */
function dirPath(logDir: string, sourceDir: string): string {
  return sourceDir === LIVE ? logDir : path.join(logDir, sourceDir);
}

/**
 * Every directory that holds sidecars: the live one, plus each archived day. A
 * missing or pruned archive directory simply does not appear, matching the
 * file-backed readers.
 */
async function sourceDirs(logDir: string): Promise<string[]> {
  const dirs = [LIVE];
  let days: string[];
  try {
    days = await readdir(path.join(logDir, "archive"));
  } catch {
    return dirs;
  }
  for (const day of days.sort()) {
    try {
      if ((await stat(path.join(logDir, "archive", day))).isDirectory()) dirs.push(`archive/${day}`);
    } catch {
      // Vanished between the listing and the stat — nothing to ingest.
    }
  }
  return dirs;
}

interface Row {
  stem: string;
  sidecar: AuditSidecar | null;
  /** Set when the file could not become a row: why not. */
  reason: "parse_error" | "not_audit_sidecar" | null;
  /** A usable ISO timestamp off an invalid-but-parsed object, for day filtering. */
  timestamp: string | null;
  mdPath: string | null;
  requestPath: string | null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function bool(v: unknown): number {
  return v ? 1 : 0;
}

/** Read one sidecar file into the shape the insert statements want. */
async function readRow(dir: string, sourceDir: string, stem: string, names: Set<string>): Promise<Row> {
  const rel = (name: string) => (sourceDir === LIVE ? name : `${sourceDir}/${name}`);
  const mdPath = names.has(`${stem}.md`) ? rel(`${stem}.md`) : null;
  const requestPath = names.has(`${stem}.request.txt`) ? rel(`${stem}.request.txt`) : null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(dir, `${stem}${AUDIT_SUFFIX}`), "utf8"));
  } catch {
    return { stem, sidecar: null, reason: "parse_error", timestamp: null, mdPath, requestPath };
  }

  if (!isAuditSidecar(parsed)) {
    // Parsed, but not a usable audit row. The file-backed reader still places it
    // by its own timestamp when it has one, so keep that here too.
    const ts = typeof parsed === "object" && parsed !== null ? str((parsed as { timestamp?: unknown }).timestamp) : null;
    return { stem, sidecar: null, reason: "not_audit_sidecar", timestamp: ts, mdPath, requestPath };
  }
  return { stem, sidecar: parsed, reason: null, timestamp: parsed.timestamp, mdPath, requestPath };
}

interface Statements {
  insertRequest: ReturnType<DatabaseSync["prepare"]>;
  insertTool: ReturnType<DatabaseSync["prepare"]>;
  insertRateLimit: ReturnType<DatabaseSync["prepare"]>;
  insertSkipped: ReturnType<DatabaseSync["prepare"]>;
  refreshBlobs: ReturnType<DatabaseSync["prepare"]>;
  deleteRequest: ReturnType<DatabaseSync["prepare"]>;
  deleteSkipped: ReturnType<DatabaseSync["prepare"]>;
  unskip: ReturnType<DatabaseSync["prepare"]>;
  watermark: ReturnType<DatabaseSync["prepare"]>;
}

function prepare(db: DatabaseSync): Statements {
  return {
    // The `DO UPDATE ... WHERE source_dir <> excluded.source_dir` handles one
    // event only: the summary job moving a sidecar from live into
    // `archive/<day>/`. The stem is unchanged, so DO NOTHING would leave the row
    // pointing at a directory it no longer lives in.
    insertRequest: db.prepare(`
      INSERT INTO request (
        id, source_dir, timestamp, model, endpoint, status_code,
        session_present, session_id, app, user_agent, account, metadata_session_id, device_id,
        tokens_input, tokens_output, tokens_cache_read, tokens_cache_creation, tokens_real_input,
        req_tool_count, req_tools_bytes, req_system_bytes, req_total_bytes,
        skim_present, skim_enabled, skim_served_from_cache, skim_saved_input_tokens, skim_cache_key,
        rate_limit_present, md_path, request_path, blob_evicted
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        source_dir   = excluded.source_dir,
        md_path      = excluded.md_path,
        request_path = excluded.request_path,
        blob_evicted = excluded.blob_evicted
      WHERE request.source_dir <> excluded.source_dir
    `),
    insertTool: db.prepare(
      "INSERT INTO request_tool (request_id, ord, name, bytes, est_tokens) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    insertRateLimit: db.prepare(
      "INSERT INTO request_rate_limit (request_id, ord, header_name, header_value) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    insertSkipped: db.prepare(`
      INSERT INTO request_skipped (id, source_dir, reason, timestamp) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET source_dir = excluded.source_dir
      WHERE request_skipped.source_dir <> excluded.source_dir
    `),
    refreshBlobs: db.prepare("UPDATE request SET md_path = ?, request_path = ?, blob_evicted = ? WHERE id = ?"),
    // Scoped by `source_dir` as well as id, so a stem already relocated to the
    // archive earlier in this pass is not deleted by the live directory.
    deleteRequest: db.prepare("DELETE FROM request WHERE id = ? AND source_dir = ?"),
    deleteSkipped: db.prepare("DELETE FROM request_skipped WHERE id = ? AND source_dir = ?"),
    unskip: db.prepare("DELETE FROM request_skipped WHERE id = ?"),
    watermark: db.prepare(`
      INSERT INTO ingest_watermark (source_dir, last_stem, files_seen, scanned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(source_dir) DO UPDATE SET
        last_stem = excluded.last_stem, files_seen = excluded.files_seen, scanned_at = excluded.scanned_at
    `),
  };
}

/** Write one already-read batch of rows. Sync, because `node:sqlite` is. */
function writeBatch(db: DatabaseSync, st: Statements, sourceDir: string, rows: Row[], stats: IngestStats): void {
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      const evicted = bool(row.mdPath === null && row.requestPath === null);
      if (!row.sidecar) {
        st.insertSkipped.run(row.stem, sourceDir, row.reason ?? "unknown", row.timestamp);
        stats.skipped += 1;
        continue;
      }
      const s = row.sidecar;
      const session = s.session;
      const skim = s.skim;
      const rateLimit = s.rateLimit;
      st.insertRequest.run(
        row.stem,
        sourceDir,
        s.timestamp,
        s.model,
        str(s.endpoint),
        typeof s.statusCode === "number" ? s.statusCode : null,
        bool(session),
        session ? str(session.sessionId) : null,
        session ? str(session.app) : null,
        session ? str(session.userAgent) : null,
        session ? str(session.account) : null,
        session ? str(session.metadataSessionId) : null,
        session ? str(session.deviceId) : null,
        num(s.tokens.input),
        num(s.tokens.output),
        num(s.tokens.cacheRead),
        num(s.tokens.cacheCreation),
        num(s.tokens.realInput),
        num(s.request.toolCount),
        num(s.request.toolsBytes),
        num(s.request.systemBytes),
        num(s.request.totalBytes),
        bool(skim),
        skim ? bool(skim.enabled) : null,
        skim ? bool(skim.servedFromCache) : null,
        skim ? num(skim.savedInputTokens) : null,
        skim ? str(skim.cacheKey) : null,
        bool(rateLimit && typeof rateLimit === "object"),
        row.mdPath,
        row.requestPath,
        evicted,
      );
      s.tools.forEach((tool, ord) => {
        st.insertTool.run(row.stem, ord, String(tool?.name ?? ""), num(tool?.bytes), num(tool?.estTokens));
      });
      if (rateLimit && typeof rateLimit === "object") {
        Object.entries(rateLimit).forEach(([name, value], ord) => {
          st.insertRateLimit.run(row.stem, ord, name, String(value));
        });
      }
      // A stem that failed to parse on an earlier pass and parses now stops
      // being a skipped file.
      st.unskip.run(row.stem);
      stats.inserted += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** How many files to parse before writing a batch — bounds peak memory on a full rebuild. */
const BATCH = 500;

/** Ingest one directory, reconciling it exactly with what is on disk. */
async function ingestDir(db: DatabaseSync, st: Statements, logDir: string, sourceDir: string, stats: IngestStats): Promise<void> {
  const dir = dirPath(logDir, sourceDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // Pruned since `sourceDirs` listed it. Its rows go with it.
    db.prepare("DELETE FROM request WHERE source_dir = ?").run(sourceDir);
    db.prepare("DELETE FROM request_skipped WHERE source_dir = ?").run(sourceDir);
    db.prepare("DELETE FROM ingest_watermark WHERE source_dir = ?").run(sourceDir);
    return;
  }

  const nameSet = new Set(names);
  const stems = names.filter((n) => n.endsWith(AUDIT_SUFFIX)).map((n) => n.slice(0, -AUDIT_SUFFIX.length)).sort();
  const lastStem = stems.length ? stems[stems.length - 1]! : null;

  // An archived day is immutable once the summary job has moved it. When its
  // listing still matches what we recorded, there is nothing to reconcile.
  const mark = db.prepare("SELECT last_stem, files_seen FROM ingest_watermark WHERE source_dir = ?").get(sourceDir) as
    | { last_stem: string | null; files_seen: number }
    | undefined;
  if (sourceDir !== LIVE && mark && mark.files_seen === stems.length && mark.last_stem === lastStem) {
    stats.dirsSkipped += 1;
    return;
  }
  stats.dirs += 1;

  const known = new Set<string>();
  for (const r of db.prepare("SELECT id FROM request WHERE source_dir = ?").all(sourceDir) as Array<{ id: string }>) {
    known.add(r.id);
  }
  const knownSkipped = new Set<string>();
  for (const r of db.prepare("SELECT id FROM request_skipped WHERE source_dir = ?").all(sourceDir) as Array<{ id: string }>) {
    knownSkipped.add(r.id);
  }

  // Rows whose file left this directory: pruned by retention, or moved into the
  // archive. A move re-inserts under the new `source_dir`, and `sourceDirs`
  // ordering (live first) means one pass sees both halves.
  const present = new Set(stems);
  db.exec("BEGIN");
  try {
    for (const id of known) {
      if (!present.has(id)) {
        st.deleteRequest.run(id, sourceDir);
        stats.deleted += 1;
      }
    }
    for (const id of knownSkipped) {
      if (!present.has(id)) {
        st.deleteSkipped.run(id, sourceDir);
        stats.deleted += 1;
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // Blob eviction is visible in the listing alone, so refresh every known row's
  // pointers without re-parsing its sidecar.
  const rel = (name: string) => (sourceDir === LIVE ? name : `${sourceDir}/${name}`);
  db.exec("BEGIN");
  try {
    for (const stem of stems) {
      if (!known.has(stem)) continue;
      const md = nameSet.has(`${stem}.md`) ? rel(`${stem}.md`) : null;
      const req = nameSet.has(`${stem}.request.txt`) ? rel(`${stem}.request.txt`) : null;
      st.refreshBlobs.run(md, req, bool(md === null && req === null), stem);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  // The live directory re-reads what it previously skipped — a sidecar caught
  // mid-write parses correctly later. An archived day is settled, so a skip
  // there stays a skip until a full rebuild.
  const fresh = stems.filter((s) => !known.has(s) && (sourceDir === LIVE || !knownSkipped.has(s)));
  for (let i = 0; i < fresh.length; i += BATCH) {
    const batch = await Promise.all(fresh.slice(i, i + BATCH).map((stem) => readRow(dir, sourceDir, stem, nameSet)));
    writeBatch(db, st, sourceDir, batch, stats);
  }

  st.watermark.run(sourceDir, lastStem, stems.length, new Date().toISOString());
}

/**
 * Bring the substrate level with `logDir`. Safe to call repeatedly and
 * concurrently with reads; a part-way failure leaves committed batches in place
 * and the next run resumes from there.
 */
export async function ingest(db: DatabaseSync, logDir: string): Promise<IngestStats> {
  const stats = emptyStats();
  const st = prepare(db);
  for (const sourceDir of await sourceDirs(logDir)) {
    await ingestDir(db, st, logDir, sourceDir, stats);
  }

  // Transcripts carry their own per-file watermark, not this dir-level one.
  const sessions = await ingestSessions(db, logDir);
  stats.sessions = sessions.seen;
  stats.sessionsParsed = sessions.parsed;
  stats.deleted += sessions.deleted;
  return stats;
}

/**
 * Ingest now, then again on every change to `logDir` and to `logDir/sessions`,
 * debounced.
 *
 * The watch is not recursive, so a file pruned inside `archive/<day>/` fires no
 * event of its own and is reconciled by the next pass. Archiving a day is
 * visible either way, since the files leave the live directory.
 *
 * `sessions/` gets a watcher of its own: the proxy appends to a transcript
 * throughout a run without touching `logDir` itself.
 *
 * Returns a stop function. Passes never overlap: a change arriving mid-pass
 * schedules one more rather than starting a second writer.
 */
export function watchAndIngest(
  db: DatabaseSync,
  logDir: string,
  opts: { debounceMs?: number; onError?: (err: Error) => void } = {},
): () => void {
  const debounceMs = opts.debounceMs ?? 500;
  const onError = opts.onError ?? (() => undefined);

  let running = false;
  let again = false;
  let timer: NodeJS.Timeout | null = null;

  const run = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await ingest(db, logDir);
    } catch (err) {
      onError(err as Error);
    } finally {
      running = false;
      if (again) {
        again = false;
        void run();
      }
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, debounceMs);
  };

  void run();

  const watchers: fs.FSWatcher[] = [];
  // A missing `sessions/` dir is normal until the proxy writes its first
  // transcript.
  for (const dir of [logDir, path.join(logDir, "sessions")]) {
    try {
      const watcher = fs.watch(dir, { persistent: false }, schedule);
      watcher.on("error", (err) => onError(err as Error));
      watchers.push(watcher);
    } catch (err) {
      onError(err as Error);
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}
