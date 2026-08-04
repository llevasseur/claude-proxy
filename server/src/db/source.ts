import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type CommandRun,
  type Concept,
  linkAgentSessions,
  parseSessionTranscript,
  reportDay,
  type SessionNode,
  type StoredConcept,
  sortConcepts,
} from '@claude-proxy/core';
import { commandStorePath, readCommandRuns as readCommandRunsFromFiles, sortCommandRuns } from '../command-runs.js';
import { conceptStorePath, readConcepts as readConceptsFromFiles } from '../concepts.js';
import {
  type ArchivedDayOptions,
  type LoadResult,
  type ReadOptions,
  readArchivedDay as readArchivedDayFromFiles,
  readSidecars as readSidecarsFromFiles,
  shiftDay,
  today,
} from '../logs.js';
import {
  listSessionGraphs as listSessionGraphsFromFiles,
  listSessions as listSessionsFromFiles,
  readSession as readSessionFromFiles,
  readSessionNodeTexts as readSessionNodeTextsFromFiles,
  resolveSessionFile,
  type SessionDetail,
  type SessionGraph,
  type SessionNodeTexts,
  type SessionSummary,
} from '../sessions.js';
import { STORE_PATH as COMMAND_STORE_PATH } from './ingest-commands.js';
import { STORE_PATH as CONCEPT_STORE_PATH } from './ingest-concepts.js';

/**
 * One interface, two backings — the seam the migration turns on. Every read
 * route reaches the log corpus through these two calls: {@link fileSource} is
 * the readdir + readFile scan, {@link dbSource} answers the same questions with
 * indexed SQL. Nothing above this line knows which one it has.
 *
 * The DB-backed implementation reproduces the file-backed one *including its
 * quirks* — filename-order iteration, unparseable files counted rather than
 * dropped, the live/archive directory split. Those quirks are observable in the
 * JSON the routes return. See `server/src/parity.ts`.
 */
export interface SidecarSource {
  readonly kind: 'files' | 'db';
  readSidecars(logDir: string, opts?: ReadOptions, now?: Date): Promise<LoadResult>;
  /**
   * `opts.archiveDir` names the relocated archive root. Only the file backing
   * consults it — the substrate answers from what was ingested.
   */
  readArchivedDay(logDir: string, date: string, opts?: ArchivedDayOptions): Promise<LoadResult>;

  /* --- Session transcripts (slice 2) --- *
   *
   * The transcript body stays on disk: {@link readSession} returns the same
   * `content` either way, and only the metadata around it moves into SQL.
   */
  listSessions(logDir: string): Promise<SessionSummary[]>;
  listSessionGraphs(logDir: string): Promise<SessionGraph[]>;
  readSession(logDir: string, id: string): Promise<SessionDetail>;
  readSessionNodeTexts(logDir: string, id: string): Promise<SessionNodeTexts>;

  /* --- Command runs (slice 3) --- *
   *
   * The live view of `logs/commands/runs.jsonl`: newest run first, retired
   * records dropped. The installed command catalogue is deliberately *not* here
   * — it lives outside `logs/`, so both backings read it the same way.
   */
  readCommandRuns(logDir: string): Promise<CommandRun[]>;

  /* --- Concepts --- *
   *
   * The live view of `logs/concepts.jsonl`: newest concept first, each carrying
   * the line it sits on as `ord`. Nothing retracts a line, so unlike the command
   * store there is no filter to apply.
   */
  readConcepts(logDir: string): Promise<StoredConcept[]>;
}

/** The behaviour the server has today: scan the directory, parse every file. */
export const fileSource: SidecarSource = {
  kind: 'files',
  readSidecars: (logDir, opts, now) => readSidecarsFromFiles(logDir, opts, now),
  readArchivedDay: (logDir, date, opts) => readArchivedDayFromFiles(logDir, date, opts),
  listSessions: (logDir) => listSessionsFromFiles(logDir),
  listSessionGraphs: (logDir) => listSessionGraphsFromFiles(logDir),
  readSession: (logDir, id) => readSessionFromFiles(logDir, id),
  readSessionNodeTexts: (logDir, id) => readSessionNodeTextsFromFiles(logDir, id),
  readCommandRuns: (logDir) => readCommandRunsFromFiles(logDir),
  readConcepts: (logDir) => readConceptsFromFiles(logDir),
};

/** The live log directory's `source_dir`; archived days are `archive/<YYYY-MM-DD>`. */
const LIVE = '';

interface RequestRow {
  id: string;
  timestamp: string;
  model: string;
  endpoint: string | null;
  status_code: number | null;
  session_present: number;
  session_id: string | null;
  app: string | null;
  user_agent: string | null;
  account: string | null;
  metadata_session_id: string | null;
  device_id: string | null;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_creation: number;
  tokens_real_input: number;
  req_tool_count: number;
  req_tools_bytes: number;
  req_system_bytes: number;
  req_total_bytes: number;
  req_system_hash: string | null;
  req_system_blocks: number | null;
  req_system_sections: number | null;
  skim_present: number;
  skim_enabled: number | null;
  skim_served_from_cache: number | null;
  skim_saved_input_tokens: number | null;
  skim_cache_key: string | null;
  rate_limit_present: number;
}

interface SkippedRow {
  id: string;
  reason: string;
  timestamp: string | null;
}

/**
 * Rebuild the sidecar object a file read would have produced. `tools` and
 * `rateLimit` keep their original `ord`: the digest's tool table breaks ties by
 * first appearance, so a reshuffle here reorders `topTools` in the response.
 */
function toSidecar(
  row: RequestRow,
  tools: Array<{ name: string; bytes: number; est_tokens: number }>,
  rateLimit: Array<{ header_name: string; header_value: string }>,
): Record<string, unknown> {
  const sidecar: Record<string, unknown> = {
    timestamp: row.timestamp,
    model: row.model,
    endpoint: row.endpoint ?? undefined,
    statusCode: row.status_code ?? undefined,
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      cacheRead: row.tokens_cache_read,
      cacheCreation: row.tokens_cache_creation,
      realInput: row.tokens_real_input,
    },
    request: {
      toolCount: row.req_tool_count,
      toolsBytes: row.req_tools_bytes,
      systemBytes: row.req_system_bytes,
      totalBytes: row.req_total_bytes,
      // Absent, not null, when the sidecar predates the capture — a file read
      // would have produced no key at all.
      ...(row.req_system_hash !== null
        ? {
            system: {
              hash: row.req_system_hash,
              blocks: row.req_system_blocks ?? 0,
              sections: row.req_system_sections ?? 0,
            },
          }
        : {}),
    },
    tools: tools.map((t) => ({ name: t.name, bytes: t.bytes, estTokens: t.est_tokens })),
  };
  if (row.session_present) {
    sidecar.session = {
      sessionId: row.session_id,
      app: row.app,
      userAgent: row.user_agent,
      account: row.account,
      metadataSessionId: row.metadata_session_id,
      deviceId: row.device_id,
    };
  }
  if (row.skim_present) {
    sidecar.skim = {
      enabled: row.skim_enabled === 1,
      servedFromCache: row.skim_served_from_cache === 1,
      savedInputTokens: row.skim_saved_input_tokens ?? 0,
      cacheKey: row.skim_cache_key,
    };
  }
  if (row.rate_limit_present) {
    const headers: Record<string, string> = {};
    for (const h of rateLimit) headers[h.header_name] = h.header_value;
    sidecar.rateLimit = headers;
  }
  return sidecar;
}

/**
 * Stand-in for a file on disk that is not a usable audit row. It must fail
 * `isAuditSidecar` like the real thing: the digest counts it under `skipped`,
 * `digestsByDay` drops it, the usage meters ignore it. No consumer reads any
 * field beyond the timestamp used to place it in a day.
 */
function invalidSidecar(stem: string, timestamp: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { __invalidSidecar: stem };
  if (timestamp !== null) out.timestamp = timestamp;
  return out;
}

/** `{ __parseError }` is what the file reader pushes for a file that would not JSON-parse. */
function parseErrorSidecar(stem: string): Record<string, unknown> {
  return { __parseError: `${stem}.audit.json` };
}

function cutoff(sinceDays: number, now: Date): string {
  return shiftDay(today(now), -(sinceDays - 1));
}

/** The day-window predicate, mirroring `readSidecars` exactly. */
function dayFilter(
  opts: ReadOptions,
  now: Date,
): { keepDay: ((day: string) => boolean) | null; from: string | null; to: string | null } {
  if (opts.date) {
    const next = shiftDay(opts.date, 1);
    return { keepDay: (day) => day === opts.date, from: opts.date, to: shiftDay(next, 1) };
  }
  if (opts.since) return { keepDay: (day) => day >= opts.since!, from: opts.since, to: null };
  if (opts.sinceDays != null) {
    const from = cutoff(opts.sinceDays, now);
    return { keepDay: (day) => day >= from, from, to: null };
  }
  return { keepDay: null, from: null, to: null };
}

function latestUserText(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string',
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n\n');
    if (text) return text;
  }
  return null;
}

/**
 * One directory's worth of sidecars, straight out of SQLite. Valid rows and
 * skipped files merge back into a single filename-ordered stream — the order
 * `readdir(...).sort()` produced, which the digest's model map, tool ties, and
 * busiest hour all inherit.
 */
async function readDir(
  db: DatabaseSync,
  logDir: string,
  sourceDir: string,
  opts: ReadOptions,
  now: Date,
): Promise<LoadResult> {
  const { keepDay, from, to } = dayFilter(opts, now);

  // The stem carries the proxy's UTC date prefix, so a range on the primary key
  // is the same prefilter the file reader does on filenames, as an index seek.
  const where: string[] = ['source_dir = ?'];
  const args: unknown[] = [sourceDir];
  if (from) {
    where.push('id >= ?');
    args.push(from);
  }
  if (to) {
    where.push('id < ?');
    args.push(to);
  }
  const clause = where.join(' AND ');

  const rows = db
    .prepare(`SELECT * FROM request WHERE ${clause} ORDER BY id`)
    .all(...(args as never[])) as unknown as RequestRow[];
  const skippedRows = db
    .prepare(`SELECT id, reason, timestamp FROM request_skipped WHERE ${clause} ORDER BY id`)
    .all(...(args as never[])) as unknown as SkippedRow[];

  const ids = rows.map((r) => r.id);
  const toolsById = new Map<string, Array<{ name: string; bytes: number; est_tokens: number }>>();
  const rateById = new Map<string, Array<{ header_name: string; header_value: string }>>();
  if (ids.length) {
    // One join per read rather than one query per request. Chunked to stay
    // under SQLite's bound-parameter ceiling.
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      for (const t of db
        .prepare(
          `SELECT request_id, name, bytes, est_tokens FROM request_tool WHERE request_id IN (${holes}) ORDER BY request_id, ord`,
        )
        .all(...(chunk as never[])) as unknown as Array<{
        request_id: string;
        name: string;
        bytes: number;
        est_tokens: number;
      }>) {
        const list = toolsById.get(t.request_id) ?? [];
        list.push({ name: t.name, bytes: t.bytes, est_tokens: t.est_tokens });
        toolsById.set(t.request_id, list);
      }
      for (const h of db
        .prepare(
          `SELECT request_id, header_name, header_value FROM request_rate_limit WHERE request_id IN (${holes}) ORDER BY request_id, ord`,
        )
        .all(...(chunk as never[])) as unknown as Array<{
        request_id: string;
        header_name: string;
        header_value: string;
      }>) {
        const list = rateById.get(h.request_id) ?? [];
        list.push({ header_name: h.header_name, header_value: h.header_value });
        rateById.set(h.request_id, list);
      }
    }
  }

  type Entry = { stem: string; make: () => Record<string, unknown>; parseError: boolean; day: string };
  const entries: Entry[] = [];
  for (const row of rows) {
    entries.push({
      stem: row.id,
      make: () => toSidecar(row, toolsById.get(row.id) ?? [], rateById.get(row.id) ?? []),
      parseError: false,
      day: reportDay(row.timestamp) ?? row.id.slice(0, 10),
    });
  }
  for (const row of skippedRows) {
    const parseError = row.reason === 'parse_error';
    entries.push({
      stem: row.id,
      make: () => (parseError ? parseErrorSidecar(row.id) : invalidSidecar(row.id, row.timestamp)),
      parseError,
      // A file that would not parse has no timestamp to be placed by, so the
      // file reader falls back to the filename's UTC day. So does this.
      day: parseError ? row.id.slice(0, 10) : (row.timestamp && reportDay(row.timestamp)) || row.id.slice(0, 10),
    });
  }
  entries.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));

  const sidecars: unknown[] = [];
  let parseErrors = 0;
  let kept = 0;
  let bodiesEvicted = 0;
  for (const entry of entries) {
    if (keepDay && !keepDay(entry.day)) continue;
    const sidecar = entry.make();
    if (entry.parseError) parseErrors += 1;
    if (opts.includeSkimRequests && !entry.parseError) {
      // The bodies stay on disk; the DB holds a pointer, not the blob. The
      // eviction count is read off the disk here too — a row's `blob_evicted` is
      // only as fresh as the last ingest, and parity needs both sides answering
      // from the same observation.
      const rel = sourceDir === LIVE ? `${entry.stem}.request.txt` : `${sourceDir}/${entry.stem}.request.txt`;
      let raw: string | null = null;
      try {
        raw = await readFile(path.join(logDir, rel), 'utf8');
      } catch {
        raw = null;
      }
      let text: string | null = null;
      if (raw === null) bodiesEvicted += 1;
      else {
        try {
          text = latestUserText(JSON.parse(raw));
        } catch {
          text = null;
        }
      }
      sidecar.skimRequestText = text ?? undefined;
    }
    if (opts.includeFile) sidecar.__file = entry.stem;
    kept += 1;
    sidecars.push(sidecar);
  }
  return { sidecars, files: kept, parseErrors, bodiesEvicted };
}

/* ------------------------------------------------------------------ *
 * Session transcripts
 * ------------------------------------------------------------------ */

interface SessionRow {
  thread_id: string;
  model: string | null;
  session_id: string | null;
  started: string | null;
  tasks: number;
  decisions: number;
  tools: number;
  errors: number;
  first_task: string | null;
  title: string | null;
  subtitle: string | null;
  derived_title: string | null;
  bytes: number;
  modified: string;
}

interface NodeRow {
  thread_id: string;
  idx: number;
  type: string;
  text: string;
  tool: string | null;
  task: string | null;
  interruption: string | null;
  interrupted: number;
  message: number | null;
}

/**
 * Rebuild the listing row a transcript parse would have produced. The key order
 * is `parseSessionTranscript`'s object literal followed by the listing's own two
 * fields, because that order is on the wire.
 */
function toSummary(row: SessionRow): SessionSummary {
  return {
    threadId: row.thread_id,
    model: row.model,
    sessionId: row.session_id,
    started: row.started,
    tasks: row.tasks,
    decisions: row.decisions,
    tools: row.tools,
    errors: row.errors,
    firstTask: row.first_task,
    title: row.title,
    subtitle: row.subtitle,
    derivedTitle: row.derived_title,
    bytes: row.bytes,
    modified: row.modified,
  };
}

/** One appended step, in `parseSessionNodes`' key order. */
function toNode(row: NodeRow): SessionNode {
  return {
    index: row.idx,
    type: row.type as SessionNode['type'],
    text: row.text,
    tool: row.tool,
    task: row.task,
    interruption: row.interruption as SessionNode['interruption'],
    interrupted: row.interrupted === 1,
    message: row.message,
  };
}

/** Newest first, ties broken by thread id — the order both listings return. */
function sortListing<T extends { modified: string; threadId: string }>(rows: T[]): T[] {
  rows.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  return rows;
}

const SESSION_COLUMNS =
  'thread_id, model, session_id, started, tasks, decisions, tools, errors, ' +
  'first_task, title, subtitle, derived_title, bytes, modified';

function sessionRows(db: DatabaseSync): SessionRow[] {
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM session`).all() as unknown as SessionRow[];
}

/** Every transcript's node stream, keyed by thread id and in transcript order. */
function nodesByThread(db: DatabaseSync): Map<string, SessionNode[]> {
  const out = new Map<string, SessionNode[]>();
  for (const row of db
    .prepare(
      'SELECT thread_id, idx, type, text, tool, task, interruption, interrupted, message FROM session_node ORDER BY thread_id, idx',
    )
    .all() as unknown as NodeRow[]) {
    const list = out.get(row.thread_id) ?? [];
    list.push(toNode(row));
    out.set(row.thread_id, list);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Command runs
 * ------------------------------------------------------------------ */

/**
 * The store's live view, out of SQLite.
 *
 * `ORDER BY ord` restores first-appearance order, then the *same* sort and the
 * same retired filter run on top, so the tie-breaking cannot drift from the file
 * side's.
 *
 * The record comes back through `document` rather than being rebuilt from the
 * columns beside it — see the schema note in `open.ts`.
 */
function commandRunsFromDb(db: DatabaseSync): CommandRun[] {
  const rows = db.prepare('SELECT document FROM command_run ORDER BY ord').all() as unknown as Array<{
    document: string;
  }>;
  return sortCommandRuns(rows.map((row) => JSON.parse(row.document) as CommandRun)).filter((run) => !run.retired);
}

/* ------------------------------------------------------------------ *
 * Concepts
 * ------------------------------------------------------------------ */

/**
 * The concept store's live view, out of SQLite.
 *
 * `ORDER BY ord` restores file order, then the *same* sort runs on top, so the
 * tie-breaking between two concepts saved in the same millisecond cannot drift
 * from the file side's. The record comes back through `document` rather than
 * being rebuilt from the columns beside it — see the schema note in `open.ts`.
 */
function conceptsFromDb(db: DatabaseSync): StoredConcept[] {
  const rows = db.prepare('SELECT ord, document FROM concept ORDER BY ord').all() as unknown as Array<{
    ord: number;
    document: string;
  }>;
  // `ord` comes off the row, not the loop index — it is the line's position in
  // the file, not this result set's.
  return sortConcepts(rows.map((row) => ({ ...(JSON.parse(row.document) as Concept), ord: row.ord })));
}

/** The same reads, answered from the substrate. */
export function dbSource(db: DatabaseSync): SidecarSource {
  return {
    kind: 'db',
    // Both listings answer from the tables alone — no directory is read.
    listSessions: async () => sortListing(sessionRows(db).map(toSummary)),
    listSessionGraphs: async () => {
      const nodes = nodesByThread(db);
      const rows = sessionRows(db).map((row) => ({ ...toSummary(row), nodes: nodes.get(row.thread_id) ?? [] }));
      // The agent tree is derived, not stored — same function the file reader
      // uses. `linkAgentSessions` sorts each family internally, so the result
      // does not depend on the order rows arrive in.
      const links = linkAgentSessions(rows);
      return sortListing(rows.map((row) => ({ ...row, ...links.get(row.threadId)! })));
    },
    readSession: async (logDir, id) => {
      // Validates the URL-supplied id and confirms the path stays inside
      // `sessions/`, as the file reader does.
      const full = resolveSessionFile(logDir, id);

      // The row holds a pointer, not the transcript, so the content comes off
      // the file either way. `stat` it in the same breath: the file's own size
      // and mtime decide which metadata belongs beside that content.
      let content: string;
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
      } catch {
        throw new Error(`session not found: ${id}`);
      }
      const bytes = info.size;
      const modified = info.mtime.toISOString();

      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE thread_id = ?`).get(id) as unknown as
        | SessionRow
        | undefined;
      if (row) {
        const { bytes: rowBytes, modified: rowModified, ...meta } = toSummary(row);
        // The row carries the exact watermark it was parsed from, so this is the
        // same equality `ingest` uses to decide a transcript is unchanged.
        if (rowBytes === bytes && rowModified === modified) return { meta, content, bytes, modified };
      }

      // The row is behind the file, or absent. Pairing its metadata with this
      // content would return an object that disagrees with itself — `bytes`
      // counting a shorter transcript than `content` holds. Re-parse instead,
      // which is what the file reader would have answered.
      return { meta: parseSessionTranscript(id, content), content, bytes, modified };
    },
    readSessionNodeTexts: async (logDir, id) => {
      // A bad id throws; a transcript with no sidecar reads as empty, not 404 —
      // the file reader's contract.
      resolveSessionFile(logDir, id);
      const texts: Record<number, string> = {};
      for (const row of db
        .prepare('SELECT idx, text FROM session_node_text WHERE thread_id = ? ORDER BY idx')
        .all(id) as unknown as Array<{ idx: number; text: string }>) {
        texts[row.idx] = row.text;
      }
      return { threadId: id, texts };
    },
    // The store is indexed whole, so this reads no file at all.
    readCommandRuns: async (logDir) => {
      // The server reconciles the store and reads it back inside the same
      // request, so rows behind the file would answer with the pre-reconcile
      // view. Same watermark equality `ingestCommandRuns` uses; anything else
      // re-reads the store, which is what the file reader would have answered.
      const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(COMMAND_STORE_PATH) as
        | { bytes: number; modified: string }
        | undefined;
      if (mark) {
        try {
          const info = await stat(commandStorePath(logDir));
          if (mark.bytes === info.size && mark.modified === info.mtime.toISOString()) return commandRunsFromDb(db);
        } catch {
          // No store on disk — the file reader answers that as no runs.
        }
      }
      return readCommandRunsFromFiles(logDir);
    },
    // The store is indexed whole, so this reads no file at all — as long as the
    // rows are provably current. `/teach` appends from outside the server, so a
    // record can land between two ingest passes; the same watermark equality
    // `ingestConcepts` uses decides, and anything else re-reads the file, which
    // is what the file reader would have answered.
    readConcepts: async (logDir) => {
      const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(CONCEPT_STORE_PATH) as
        | { bytes: number; modified: string }
        | undefined;
      if (mark) {
        try {
          const info = await stat(conceptStorePath(logDir));
          if (mark.bytes === info.size && mark.modified === info.mtime.toISOString()) return conceptsFromDb(db);
        } catch {
          // No store on disk — the file reader answers that as no concepts.
        }
      }
      return readConceptsFromFiles(logDir);
    },
    readSidecars: (logDir, opts = {}, now = new Date()) => readDir(db, logDir, LIVE, opts, now),
    readArchivedDay: async (logDir, date, opts = {}) => {
      // `archiveDir` is a file-backing concern; the substrate reads by `source_dir`.
      const { archiveDir: _archiveDir, ...readOpts } = opts;
      const out: LoadResult = { sidecars: [], files: 0, parseErrors: 0, bodiesEvicted: 0 };
      // Archive folders are named for the UTC day the summary job moved, so one
      // reporting day straddles two of them. Read both, keep only `date`.
      for (const day of [date, shiftDay(date, 1)]) {
        const r = await readDir(db, logDir, `archive/${day}`, { ...readOpts, date }, new Date());
        out.sidecars.push(...r.sidecars);
        out.files += r.files;
        out.parseErrors += r.parseErrors;
        out.bodiesEvicted = (out.bodiesEvicted ?? 0) + (r.bodiesEvicted ?? 0);
      }
      return out;
    },
  };
}
