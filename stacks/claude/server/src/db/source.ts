import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  type CommandRun,
  type Concept,
  dayOf,
  isAuditSidecar,
  linkAgentSessions,
  parseSessionTranscript,
  type RecordedSpawn,
  reportDay,
  type SessionNode,
  type StoredConcept,
  sortConcepts,
} from '@agent-proxy/claude-core';
import {
  commandStorePath,
  readCommandRuns as readCommandRunsFromFiles,
  type StoreAppend,
  sortCommandRuns,
} from '../command-runs.js';
import { conceptStorePath, readConcepts as readConceptsFromFiles } from '../concepts.js';
import { latestUserText } from '../derive.js';
import { type JsonInput, type JsonValue, jsonField, stringField } from '../json.js';
import {
  type ArchivedDayOptions,
  compareByTimestamp,
  type LoadResult,
  mergeByTimestamp,
  type ReadOptions,
  readArchivedDay as readArchivedDayFromFiles,
  readSidecars as readSidecarsFromFiles,
  shiftDay,
  today,
} from '../logs.js';
import { listArchiveDays, logFileDay } from '../retention.js';
import {
  listSessionGraphs as listSessionGraphsFromFiles,
  listSessions as listSessionsFromFiles,
  readPrLinks as readPrLinksFromFiles,
  readRootPrompts as readRootPromptsFromFiles,
  readSession as readSessionFromFiles,
  readSessionNodeTexts as readSessionNodeTextsFromFiles,
  resolveSessionFile,
  type SessionDetail,
  type SessionGraph,
  type SessionNodeTexts,
  type SessionSummary,
} from '../sessions.js';
import { applyCommandRunAppend, STORE_PATH as COMMAND_STORE_PATH } from './ingest-commands.js';
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

  /**
   * The oldest reporting day this backing can answer for, or `null` when it
   * holds nothing at all. **This is the floor an `all: true` window is resolved
   * against** — the one thing {@link readWindow} used to be missing, and the
   * reason an unbounded span could only answer with the live root.
   *
   * It is a lookup, not a guess, on either backing: a listing of the archive's
   * day directories on the file side, an indexed `MIN` on the DB side. Both
   * step one day back off the earliest UTC name they find, because reporting
   * days lag UTC ones — the first archived directory can hold the tail of the
   * day before it.
   */
  oldestDay(logDir: string, opts?: { archiveDir?: string }): Promise<string | null>;

  /**
   * Every archived day in `days` at once, keyed by reporting day. Optional: a
   * backing that has nothing better than the per-day walk simply omits it and
   * {@link readWindow} calls {@link readArchivedDay} per day as before.
   *
   * The DB implements it, and that is what keeps an all-time read from being a
   * scaling problem — one range-free query over an indexed column instead of two
   * per day in a span that now runs to the beginning of the corpus.
   */
  readAllDays?(logDir: string, days: readonly string[], opts?: ArchivedDayOptions): Promise<Map<string, LoadResult>>;

  /**
   * One thread's captured requests inside the window, and nothing else. Optional:
   * a backing with nothing better than the window scan omits it, and
   * {@link readThreadWindow} reads the window and filters, exactly as the thread
   * route did before this method existed.
   *
   * The DB implements it, and that is the whole point — `request.thread_id` is
   * indexed (`request_thread_idx`), so one thread comes back as an index seek
   * rather than as every sidecar in the span materialized and then discarded.
   * The window's day rules still apply: this answers the same rows the window
   * read would have, not every row the thread ever sent.
   */
  readThread?(logDir: string, threadId: string, opts?: WindowOptions, now?: Date): Promise<ThreadReadResult>;

  /* --- Session transcripts (slice 2) --- *
   *
   * The transcript body stays on disk: {@link readSession} returns the same
   * `content` either way, and only the metadata around it moves into SQL.
   */
  listSessions(logDir: string): Promise<SessionSummary[]>;
  listSessionGraphs(logDir: string): Promise<SessionGraph[]>;
  readSession(logDir: string, id: string): Promise<SessionDetail>;
  readSessionNodeTexts(logDir: string, id: string): Promise<SessionNodeTexts>;
  /**
   * The untruncated opening prompts of the named threads, thread id → prompt.
   * Ids with nothing on record are absent rather than null, so the two backings
   * cannot disagree about which flavour of "no prompt" a thread has.
   */
  readRootPrompts(logDir: string, threadIds: readonly string[]): Promise<Map<string, string>>;
  /**
   * Every thread that recorded the pull request it opened, thread id → url. Asked
   * for wholesale rather than by id, because the caller's question runs the other
   * way: which threads name the pull requests it is about to draw.
   *
   * A thread with nothing on record is absent, so both backings agree that "no
   * link" is one state rather than two. **This is the fast path behind
   * `/api/pull-requests`** — on the substrate it is one indexed query, in place of
   * reading every transcript in `logs/sessions/` to recover the same link from
   * text.
   */
  readPrLinks(logDir: string): Promise<Map<string, string>>;

  /* --- Command runs (slice 3) --- *
   *
   * The live view of `logs/commands/runs.jsonl`: newest run first, retired
   * records dropped. The installed command catalogue is deliberately *not* here
   * — it lives outside `logs/`, so both backings read it the same way.
   */
  readCommandRuns(logDir: string): Promise<CommandRun[]>;

  /**
   * Fold an append the server itself just made into whatever this backing reads
   * from, so the read beside it need not go back to the file for it. Returns whether
   * the fold happened.
   *
   * Optional because only the substrate has anything to move — the file backing *is*
   * the store. A `false`, from a backing that declines or rows that do not sit where
   * the append started, is not a failure: {@link readCommandRuns} then re-reads the
   * file exactly as it did before.
   */
  syncCommandRuns?(logDir: string, append: StoreAppend): Promise<boolean>;

  /* --- Concepts --- *
   *
   * The live view of `logs/concepts.jsonl`: newest concept first, each carrying
   * the line it sits on as `ord`. Nothing retracts a line, so unlike the command
   * store there is no filter to apply.
   */
  readConcepts(logDir: string): Promise<StoredConcept[]>;
}

/**
 * The oldest day on disk. The archive's day directories are the answer whenever
 * there are any — `listArchiveDays` is the same listing `collectRetentionCorpus`
 * does, and the same `DAY_DIR_RE` rejects a name that is not a date — and the
 * live root's dated filenames cover the deployment that has not archived yet.
 *
 * One day back off the earliest name found, because filenames carry the proxy's
 * UTC prefix while a window walks reporting days: the earliest file can belong
 * to the reporting day before the one it is named for.
 */
async function oldestDayOnDisk(logDir: string, archiveDir?: string): Promise<string | null> {
  const days = await listArchiveDays(archiveDir ?? path.join(logDir, 'archive'));
  let earliest = days[0] ?? null;

  let live: string[];
  try {
    live = await readdir(logDir);
  } catch {
    live = [];
  }
  for (const name of live) {
    const day = logFileDay(name);
    if (day !== null && (earliest === null || day < earliest)) earliest = day;
  }

  return earliest === null ? null : shiftDay(earliest, -1);
}

/** The behaviour the server has today: scan the directory, parse every file. */
export const fileSource: SidecarSource = {
  kind: 'files',
  readSidecars: (logDir, opts, now) => readSidecarsFromFiles(logDir, opts, now),
  readArchivedDay: (logDir, date, opts) => readArchivedDayFromFiles(logDir, date, opts),
  oldestDay: (logDir, opts) => oldestDayOnDisk(logDir, opts?.archiveDir),
  listSessions: (logDir) => listSessionsFromFiles(logDir),
  listSessionGraphs: (logDir) => listSessionGraphsFromFiles(logDir),
  readSession: (logDir, id) => readSessionFromFiles(logDir, id),
  readSessionNodeTexts: (logDir, id) => readSessionNodeTextsFromFiles(logDir, id),
  readRootPrompts: (logDir, threadIds) => readRootPromptsFromFiles(logDir, threadIds),
  readPrLinks: (logDir) => readPrLinksFromFiles(logDir),
  readCommandRuns: (logDir) => readCommandRunsFromFiles(logDir),
  readConcepts: (logDir) => readConceptsFromFiles(logDir),
};

export interface WindowOptions extends ReadOptions {
  /**
   * Root of the relocated archive. Only the file backing consults it — the
   * substrate answers from what was ingested.
   */
  archiveDir?: string;
  /**
   * Read every day on record. The floor comes from
   * {@link SidecarSource.oldestDay} and is resolved **once, here**, into an
   * ordinary `since` — so this is one more bounded span by the time anything
   * below this option sees it, and no existing caller's code path changes.
   *
   * Ignored when the caller already named a span; an explicit `date`, `since`
   * or `sinceDays` is a floor, and this option only supplies a missing one.
   */
  all?: boolean;
}

export interface WindowResult extends LoadResult {
  /** Reporting day → that day's sidecars, archived half first. Only days that read something. */
  byDay: Map<string, unknown[]>;
  /** How many days in the span had an archived half with files in it. */
  archivedDays: number;
  /**
   * The days the archive was consulted for, oldest→newest. Empty only for a
   * span with no floor at all — `all: true` supplies one from the corpus, so an
   * all-time read reports the days it covered like any other window.
   */
  days: string[];
}

/**
 * The days a window covers, oldest→newest; empty when the span has no floor.
 *
 * Exported because a caller that reads the window **a day at a time** — see
 * `buildContext`, which caches each closed day's aggregate — has to walk exactly
 * the days this function would have composed, or its span and the window read's
 * would drift apart.
 */
export function windowDays(opts: WindowOptions, now: Date): string[] {
  const end = today(now);
  if (opts.date) return [opts.date];
  const from = opts.since ?? (opts.sinceDays == null ? null : shiftDay(end, -(opts.sinceDays - 1)));
  if (from === null) return [];
  const days: string[] = [];
  for (let day = from; day <= end; day = shiftDay(day, 1)) days.push(day);
  return days;
}

/**
 * **The only way a multi-day window is read.** `readSidecars` scans one root and
 * stops there, so a builder that calls it directly sees today and whatever else
 * `maintain` has not archived yet — the day it moves into `<logDir>/archive/<date>/`
 * simply vanishes from that builder's answer. Four builders each rediscovered
 * that and three feature docs each recorded it as an open question; composing the
 * two halves here means a new builder cannot forget to.
 *
 * The two halves are read per day and concatenated archived-first, so the stream
 * stays chronological across the seam where a day is half archived and half live.
 * Reporting days and the archiver's UTC rotation do not line up, so a day near
 * the present genuinely sits in both places.
 *
 * `readSidecars` stays exactly what it was: the single-root primitive underneath.
 *
 * An unbounded span — no `date`, `since`, `sinceDays`, **or `all`** — still reads
 * the live root only, because there is genuinely no first day to walk from. `all`
 * is how a caller asks for the floor instead of that: the backing looks up the
 * oldest day it holds, this function turns it into a `since` once, and everything
 * below here composes an ordinary bounded span.
 */
export async function readWindow(
  logDir: string,
  opts: WindowOptions = {},
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<WindowResult> {
  // The span narrows the live read; the archived halves are addressed by day, so
  // they take only the per-file options.
  const { archiveDir, all, ...requested } = opts;

  // Resolved once per request, before anything reads. An empty corpus has no
  // floor to find, and today is the honest answer for it — a one-day span, not
  // a walk back through days that never existed.
  const bounded = requested.date || requested.since || requested.sinceDays != null;
  const floor = all && !bounded ? ((await source.oldestDay(logDir, { archiveDir })) ?? today(now)) : null;
  const readOpts: ReadOptions = floor === null ? requested : { ...requested, since: floor };

  const { date: _date, since: _since, sinceDays: _sinceDays, ...perFile } = readOpts;
  const days = windowDays(readOpts, now);

  // The whole archive in one read where the backing offers it; otherwise the
  // per-day walk, which is exactly what every bounded span already does.
  const wholeArchive =
    floor !== null && source.readAllDays ? await source.readAllDays(logDir, days, { ...perFile, archiveDir }) : null;
  const archived = wholeArchive
    ? days.map((day) => ({ day, read: wholeArchive.get(day) ?? EMPTY_READ }))
    : await Promise.all(
        days.map(async (day) => ({
          day,
          read: await source.readArchivedDay(logDir, day, { ...perFile, archiveDir }),
        })),
      );
  const live = await source.readSidecars(logDir, readOpts, now);

  const byDay = new Map<string, unknown[]>();
  const sidecars: unknown[] = [];
  let files = live.files;
  let parseErrors = live.parseErrors;
  let bodiesEvicted = live.bodiesEvicted ?? 0;
  let archivedDays = 0;

  for (const { day, read } of archived) {
    if (read.files === 0) continue;
    archivedDays += 1;
    files += read.files;
    parseErrors += read.parseErrors;
    bodiesEvicted += read.bodiesEvicted ?? 0;
    sidecars.push(...read.sidecars);
    byDay.set(day, [...read.sidecars]);
  }
  for (const sidecar of live.sidecars) {
    if (!readOpts.orderByTimestamp) sidecars.push(sidecar);
    if (!isAuditSidecar(sidecar)) continue;
    const day = dayOf(sidecar);
    const bucket = byDay.get(day) ?? [];
    bucket.push(sidecar);
    byDay.set(day, bucket);
  }

  // The seam the flag exists for. A reporting day near the present sits in both
  // halves, so archived-then-live is chronological everywhere except there —
  // and a caller that wanted chronology had to sort the whole window to fix a
  // handful of rows. Both halves arrive ordered, so one linear merge is the
  // whole repair: `byDay` is untouched, because it is keyed by reporting day and
  // a day's rows are the same set whichever half they were read from.
  const ordered = readOpts.orderByTimestamp ? mergeByTimestamp(sidecars, live.sidecars) : sidecars;

  return { sidecars: ordered, files, parseErrors, bodiesEvicted, byDay, archivedDays, days };
}

/** What a thread read answers: the window's rows for one thread, and their count. */
export interface ThreadReadResult {
  /** The thread's sidecars, in the order the window read would have produced them. */
  sidecars: unknown[];
  /**
   * How many of them there are — **the thread's own captured requests, not the
   * window's files.** A read that never materializes the rest of the window has
   * no count of it to report, and the thread page never showed one.
   */
  files: number;
  /**
   * Always `0`. A file that would not parse, or that is not an audit sidecar,
   * carries no thread id, so it belongs to no thread and cannot be counted
   * against one. Kept in the shape so the route's `meta` stays what it was.
   */
  parseErrors: number;
}

/** The transcript a sidecar is a turn of, or `null` for anything that names none. */
function sidecarThreadId(sidecar: JsonInput): string | null {
  return stringField(jsonField(sidecar, 'session'), 'threadId') ?? null;
}

/**
 * **One thread's slice of a window, asked for as a thread rather than as a
 * window.** The thread page wants the requests of one transcript; reading every
 * sidecar in the span to keep a handful of them is the cost that made a
 * 394-byte answer take seconds.
 *
 * Which backing is in play decides how that is avoided, and the seam is where
 * the two meet: {@link SidecarSource.readThread} answers from the thread index
 * when the backing has one, and a backing without it falls through to exactly
 * the read this function replaced — {@link readWindow}, then a filter — so the
 * file side keeps the scan it has always done and the answers stay identical.
 */
export async function readThreadWindow(
  logDir: string,
  threadId: string,
  opts: WindowOptions = {},
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ThreadReadResult> {
  if (source.readThread) return source.readThread(logDir, threadId, opts, now);

  const { sidecars } = await readWindow(logDir, opts, now, source);
  // SAFETY: `LoadResult` types this stream as `unknown[]`, but both producers put a
  // JSON document in it — the file reader pushes `JSON.parse` output from an
  // `.audit.json`, and the substrate pushes what `toSidecar` assembles out of
  // TEXT/INTEGER columns — so every member is inside `JsonValue`. The reader
  // answers `null` for any other shape, which is what the tag checks used to do.
  const mine = sidecars.filter((sidecar) => sidecarThreadId(sidecar as JsonInput) === threadId);
  return { sidecars: mine, files: mine.length, parseErrors: 0 };
}

/** A day the whole-archive read returned nothing for; the walk's answer for it too. */
const EMPTY_READ: LoadResult = { sidecars: [], files: 0, parseErrors: 0, bodiesEvicted: 0 };

/**
 * The `?days=` a route reads as "every day on record". `0` rather than a large
 * number: a count of days cannot express all-time, and clamping it to 1 is what
 * used to make the widest question the pickers could ask a 30-day one.
 */
export const ALL_DAYS = 0;

/**
 * {@link ALL_DAYS} as a concrete count of days, so a builder that walks a fixed
 * date range keeps taking a number and keeps its current code path. Anything
 * else is returned untouched.
 */
export async function resolveAllDays(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
  archiveDir?: string,
): Promise<number> {
  if (days !== ALL_DAYS) return days;
  const floor = await source.oldestDay(logDir, { archiveDir });
  if (floor === null) return 1;
  // Inclusive of both ends, and never less than a day — the corpus always has
  // at least the day its floor names.
  const span = Math.round((Date.parse(`${today(now)}T00:00:00Z`) - Date.parse(`${floor}T00:00:00Z`)) / 86_400_000) + 1;
  return Math.max(1, span);
}

/** The live log directory's `source_dir`; archived days are `archive/<YYYY-MM-DD>`. */
const LIVE = '';

/**
 * A value a rebuilt sidecar carries. `undefined` is in the union deliberately: a
 * file read produced *no key at all* where a column is null, and `JSON.stringify`
 * drops an explicitly-`undefined` key the same way it drops a missing one, so the
 * two backings stay byte-identical on the wire.
 */
type SidecarValue = JsonValue | SidecarObject | undefined;

/** The object a file read would have parsed, as this module rebuilds it from SQL. */
interface SidecarObject {
  [key: string]: SidecarValue;
}

/**
 * Every row type below is written as a `type` rather than an `interface` on
 * purpose. `StatementSync.all()` answers `Record<string, SQLOutputValue>[]`, and
 * only an object type alias picks up the implicit index signature that makes the
 * row shape comparable to it — so each `as` below stays a single assertion instead
 * of a chain through `unknown`.
 */

/**
 * The columns {@link entriesFrom} selects from `request`.
 *
 * `skim_text` is not here to omit: it holds the last user turn of every request body,
 * tens of kilobytes across nearly every row, and lives in the `request_skim` side
 * table — fetched as {@link SkimTextRow} by the one read that uses it. `md_path` and
 * `blob_evicted` are never read here.
 */
type RequestRow = {
  id: string;
  timestamp: string;
  model: string;
  endpoint: string | null;
  status_code: number | null;
  session_present: number;
  session_id: string | null;
  thread_id: string | null;
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
  cache_breakpoint_injected: number | null;
  cache_breakpoint_observed: number | null;
  cache_breakpoint_declined_by: string | null;
  rate_limit_present: number;
  source_dir: string;
  /** Whether the body was ever read for its derivatives. See `deriveBodies`. */
  body_derived: number;
  /**
   * The `.request.txt` beside this sidecar, or null once eviction deleted it.
   * The eviction ledger the skim reads — `blob_evicted` beside it means *both*
   * bodies are gone, a stricter question than the one `bodiesEvicted` asks.
   */
  request_path: string | null;
};

type SkippedRow = {
  id: string;
  reason: string;
  timestamp: string | null;
  source_dir: string;
};

/** One `request_tool` row, joined back to the request it belongs to. */
type ToolRow = { request_id: string; name: string; bytes: number; est_tokens: number };

/** One `request_rate_limit` header, joined back to the request it belongs to. */
type RateLimitRow = { request_id: string; header_name: string; header_value: string };

/** One derived last-user-turn, keyed by the request it was extracted from. */
type SkimTextRow = { id: string; skim_text: string | null };

/**
 * Every column {@link RequestRow} declares, in the order it declares them, written as
 * a key set so `tsc` checks it in both directions: `satisfies` refuses a name that is
 * not a field, and the record's keys are all required, so it refuses a field that is
 * missing a name. That second direction is the one worth the shape. The select's rows
 * are asserted `as RequestRow[]`, and a column dropped from this list would leave that
 * assertion claiming a field the query never asked for — `undefined` at runtime, in a
 * sidecar, with the type still insisting it is a string.
 */
const REQUEST_COLUMN_SET = {
  id: true,
  timestamp: true,
  model: true,
  endpoint: true,
  status_code: true,
  session_present: true,
  session_id: true,
  thread_id: true,
  app: true,
  user_agent: true,
  account: true,
  metadata_session_id: true,
  device_id: true,
  tokens_input: true,
  tokens_output: true,
  tokens_cache_read: true,
  tokens_cache_creation: true,
  tokens_real_input: true,
  req_tool_count: true,
  req_tools_bytes: true,
  req_system_bytes: true,
  req_total_bytes: true,
  req_system_hash: true,
  req_system_blocks: true,
  req_system_sections: true,
  skim_present: true,
  skim_enabled: true,
  skim_served_from_cache: true,
  skim_saved_input_tokens: true,
  skim_cache_key: true,
  cache_breakpoint_injected: true,
  cache_breakpoint_observed: true,
  cache_breakpoint_declined_by: true,
  rate_limit_present: true,
  source_dir: true,
  body_derived: true,
  request_path: true,
} as const satisfies Record<keyof RequestRow, true>;

const REQUEST_COLUMNS = Object.keys(REQUEST_COLUMN_SET).join(', ');

/**
 * Rebuild the sidecar object a file read would have produced. `tools` and
 * `rateLimit` keep their original `ord`: the digest's tool table breaks ties by
 * first appearance, so a reshuffle here reorders `topTools` in the response.
 */
function toSidecar(
  row: RequestRow,
  tools: Array<{ name: string; bytes: number; est_tokens: number }>,
  rateLimit: Array<{ header_name: string; header_value: string }>,
): SidecarObject {
  // Built before the sidecar it sits in, so `system` still lands last among the
  // request's keys — the position the file read's object literal gave it.
  const request: SidecarObject = {
    toolCount: row.req_tool_count,
    toolsBytes: row.req_tools_bytes,
    systemBytes: row.req_system_bytes,
    totalBytes: row.req_total_bytes,
  };
  // Absent, not null, when the sidecar predates the capture — a file read
  // would have produced no key at all.
  if (row.req_system_hash !== null) {
    request.system = {
      hash: row.req_system_hash,
      blocks: row.req_system_blocks ?? 0,
      sections: row.req_system_sections ?? 0,
    };
  }

  const sidecar: SidecarObject = {
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
    request,
    tools: tools.map((t) => ({ name: t.name, bytes: t.bytes, estTokens: t.est_tokens })),
  };
  if (row.session_present) {
    const session: SidecarObject = {
      sessionId: row.session_id,
      app: row.app,
      userAgent: row.user_agent,
      account: row.account,
      metadataSessionId: row.metadata_session_id,
      deviceId: row.device_id,
    };
    // Absent, not null, when the sidecar predates the capture — a file read
    // would have produced no key at all.
    if (row.thread_id !== null) session.threadId = row.thread_id;
    sidecar.session = session;
  }
  if (row.skim_present) {
    sidecar.skim = {
      enabled: row.skim_enabled === 1,
      servedFromCache: row.skim_served_from_cache === 1,
      savedInputTokens: row.skim_saved_input_tokens ?? 0,
      cacheKey: row.skim_cache_key,
    };
  }
  // Absent, not false, when the sidecar predates the injector — a file read would
  // have produced no key at all.
  if (row.cache_breakpoint_injected !== null) {
    sidecar.cacheBreakpointInjected = row.cache_breakpoint_injected === 1;
  }
  // Written together, so the observation column says whether either was recorded.
  // `declinedBy` then comes back null — "nothing declined" — rather than absent.
  if (row.cache_breakpoint_observed !== null) {
    sidecar.cacheBreakpointObserved = row.cache_breakpoint_observed === 1;
    sidecar.cacheBreakpointDeclinedBy = row.cache_breakpoint_declined_by;
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
function invalidSidecar(stem: string, timestamp: string | null): SidecarObject {
  const out: SidecarObject = { __invalidSidecar: stem };
  if (timestamp !== null) out.timestamp = timestamp;
  return out;
}

/** `{ __parseError }` is what the file reader pushes for a file that would not JSON-parse. */
function parseErrorSidecar(stem: string): SidecarObject {
  return { __parseError: `${stem}.audit.json` };
}

function cutoff(sinceDays: number, now: Date): string {
  return shiftDay(today(now), -(sinceDays - 1));
}

/**
 * The day-window predicate a span resolves to, plus the `id` range that
 * prefilters it. `keepDay` is null for a span with no floor — everything is kept.
 */
type DayFilter = {
  keepDay: ((day: string) => boolean) | null;
  from: string | null;
  to: string | null;
};

/** The day-window predicate, mirroring `readSidecars` exactly. */
function dayFilter(opts: ReadOptions, now: Date): DayFilter {
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
  const args: SQLInputValue[] = [sourceDir];
  if (from) {
    where.push('id >= ?');
    args.push(from);
  }
  if (to) {
    where.push('id < ?');
    args.push(to);
  }
  const clause = where.join(' AND ');

  const entries = entriesFrom(db, clause, args, opts);
  if (opts.orderByTimestamp) entries.sort(compareByTimestamp);
  else entries.sort((a, b) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
  return materialize(logDir, entries, keepDay, opts);
}

/** One row of the merged stream, before the day filter and the body reads. */
type Entry = {
  stem: string;
  /**
   * The row's ISO `timestamp`, or `''` for a skipped file — which has no
   * `request` row and so nothing to read one from. Only `orderByTimestamp`
   * consults it, and the empty string is the same rule the file backing applies
   * to a sidecar that would not parse.
   */
  timestamp: string;
  sourceDir: string;
  make: () => SidecarObject;
  parseError: boolean;
  day: string;
  /** Whether ingest already read this row's body for its derivatives. */
  derived: boolean;
  /**
   * The derivative, for a row that can reach it — `derived`, or `evicted` — and only
   * when the read asked for the request bodies. Null for any other row, which no
   * branch reads.
   */
  skimText: string | null;
  /**
   * Whether this row's `.request.txt` is gone, off the column ingest maintains.
   * `null` where there is no column to answer from — a skipped file, which has
   * no `request` row — and only those go back to the disk.
   */
  evicted: boolean | null;
};

/**
 * The valid and skipped rows a `WHERE` clause selects, merged into one unsorted
 * stream. Factored out of {@link readDir} so the whole-archive read can issue the
 * clause once for every day at a time rather than twice per day.
 *
 * `opts.omitTools` drops the `request_tool` fetch outright and leaves every
 * sidecar's `tools` array empty — see {@link ReadOptions.omitTools}. That is the
 * one query here whose size is the *window times the tool count*, so a caller
 * reading only `request.toolCount` pays for a join whose result it throws away.
 *
 * `opts.includeSkimRequests` gates the `skim_text` fetch. It has to agree with the
 * flag {@link materialize} is handed for the same entries — pass it to one and not
 * the other and those entries' `skimText` is silently null.
 */
function entriesFrom(db: DatabaseSync, clause: string, args: SQLInputValue[], opts: ReadOptions = {}): Entry[] {
  // SAFETY: the SELECT names `REQUEST_COLUMNS`, which is the field list `RequestRow`
  // declares and nothing besides — and `tsc` is what holds that, not this comment,
  // since the list is a `satisfies Record<keyof RequestRow, true>` key set.
  //
  // `ORDER BY source_dir, id` is `request_window_covering_idx`'s own order (schema
  // v21). Asked for `id` alone SQLite cannot use an index keyed `(source_dir, id, …)`
  // and scans the primary key instead, so this exists for the `source_dir <> ''`
  // read; the per-day read reaches the index either way, its `source_dir = ?` being
  // an equality.
  //
  // Nothing downstream reads this order — all three callers sort the entries
  // themselves, so the SQL order is an optimizer hint, not a contract.
  // `request_skipped` below keeps `ORDER BY id`, having no covering index to reach.
  const rows = db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM request WHERE ${clause} ORDER BY source_dir, id`)
    .all(...args) as RequestRow[];
  // SAFETY: the SELECT above names exactly id, reason, timestamp and source_dir, so
  // every row carries those four columns as `SkippedRow` declares them.
  const skippedRows = db
    .prepare(`SELECT id, reason, timestamp, source_dir FROM request_skipped WHERE ${clause} ORDER BY id`)
    .all(...args) as SkippedRow[];

  const ids = rows.map((r) => r.id);
  const toolsById = new Map<string, Array<{ name: string; bytes: number; est_tokens: number }>>();
  const rateById = new Map<string, Array<{ header_name: string; header_value: string }>>();
  if (ids.length) {
    // One join per read rather than one query per request. Chunked to stay
    // under SQLite's bound-parameter ceiling.
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const holes = chunk.map(() => '?').join(',');
      if (!opts.omitTools) {
        // SAFETY: the SELECT names exactly request_id, name, bytes and est_tokens, so
        // every row carries those four columns as `ToolRow` declares them.
        const toolRows = db
          .prepare(
            `SELECT request_id, name, bytes, est_tokens FROM request_tool WHERE request_id IN (${holes}) ORDER BY request_id, ord`,
          )
          .all(...chunk) as ToolRow[];
        for (const t of toolRows) {
          const list = toolsById.get(t.request_id) ?? [];
          list.push({ name: t.name, bytes: t.bytes, est_tokens: t.est_tokens });
          toolsById.set(t.request_id, list);
        }
      }
      // SAFETY: the SELECT names exactly request_id, header_name and header_value, so
      // every row carries those three columns as `RateLimitRow` declares them.
      const rateRows = db
        .prepare(
          `SELECT request_id, header_name, header_value FROM request_rate_limit WHERE request_id IN (${holes}) ORDER BY request_id, ord`,
        )
        .all(...chunk) as RateLimitRow[];
      for (const h of rateRows) {
        const list = rateById.get(h.request_id) ?? [];
        list.push({ header_name: h.header_name, header_value: h.header_value });
        rateById.set(h.request_id, list);
      }
    }
  }

  // The prose the main select never touches, fetched only when the caller asked for
  // the request bodies, and only for the rows {@link materialize} can consult it on —
  // a body already derived, or one eviction has taken. A LEFT JOIN, because a body
  // that derived to null has no `request_skim` row and still belongs in the map.
  const skimById = new Map<string, string | null>();
  if (opts.includeSkimRequests) {
    // SAFETY: the SELECT names exactly id and skim_text, so every row carries those
    // two columns as `SkimTextRow` declares them.
    const skimRows = db
      .prepare(
        `SELECT request.id AS id, request_skim.skim_text AS skim_text FROM request
         LEFT JOIN request_skim ON request_skim.request_id = request.id
         WHERE (${clause}) AND (body_derived = 1 OR request_path IS NULL)`,
      )
      .all(...args) as SkimTextRow[];
    for (const s of skimRows) skimById.set(s.id, s.skim_text);
  }

  const entries: Entry[] = [];
  for (const row of rows) {
    entries.push({
      stem: row.id,
      timestamp: row.timestamp,
      sourceDir: row.source_dir,
      make: () => toSidecar(row, toolsById.get(row.id) ?? [], rateById.get(row.id) ?? []),
      parseError: false,
      day: reportDay(row.timestamp) ?? row.id.slice(0, 10),
      derived: row.body_derived === 1,
      // Absent from the map is a null column for every row that reads this: the
      // `WHERE` above selected precisely those rows.
      skimText: skimById.get(row.id) ?? null,
      evicted: row.request_path === null,
    });
  }
  for (const row of skippedRows) {
    const parseError = row.reason === 'parse_error';
    entries.push({
      stem: row.id,
      // A parse error yields a marker with no `timestamp` field at all, which is
      // what the file backing keys as the empty string; anything else keeps the
      // timestamp ingest recorded, which is the one the file backing reads back
      // off the parsed object.
      timestamp: parseError ? '' : (row.timestamp ?? ''),
      sourceDir: row.source_dir,
      make: () => (parseError ? parseErrorSidecar(row.id) : invalidSidecar(row.id, row.timestamp)),
      parseError,
      // A file that would not parse has no timestamp to be placed by, so the
      // file reader falls back to the filename's UTC day. So does this.
      day: parseError ? row.id.slice(0, 10) : (row.timestamp && reportDay(row.timestamp)) || row.id.slice(0, 10),
      // A skipped file has no `request` row, so nothing derived one — and no
      // column records whether its body is still there either.
      derived: false,
      skimText: null,
      evicted: null,
    });
  }
  return entries;
}

/** Build the sidecars an already-ordered entry stream stands for. */
async function materialize(
  logDir: string,
  entries: readonly Entry[],
  keepDay: ((day: string) => boolean) | null,
  opts: ReadOptions,
): Promise<LoadResult> {
  const sidecars: unknown[] = [];
  let parseErrors = 0;
  let kept = 0;
  let bodiesEvicted = 0;
  for (const entry of entries) {
    if (keepDay && !keepDay(entry.day)) continue;
    const sidecar = entry.make();
    if (entry.parseError) parseErrors += 1;
    if (opts.includeSkimRequests && !entry.parseError) {
      // The bodies stay on disk; the DB holds a pointer, not the blob, and the
      // eviction count comes off that pointer rather than a `stat` per row.
      //
      // The column is trustworthy at the one moment eviction moves it because
      // `ingestDir` fingerprints the whole directory listing rather than its
      // audit stems, so deleting a body invalidates that day's watermark.
      // `maintain --apply` runs a pass on both sides of its evict phase.
      const rel =
        entry.sourceDir === LIVE ? `${entry.stem}.request.txt` : `${entry.sourceDir}/${entry.stem}.request.txt`;
      const abs = path.join(logDir, rel);
      let text: string | null = null;
      if (entry.evicted === true) {
        // The pointer is null: the body is gone. `skim_text` outlives it when a
        // pass derived it first.
        bodiesEvicted += 1;
        text = entry.skimText;
      } else if (entry.derived) {
        // Ingest read this body and the pointer says it is still there, so
        // nothing touches the disk.
        text = entry.skimText;
      } else {
        // No derivative and no pointer to trust: a row ingested before the
        // extraction existed, or a skipped file, which has no `request` row.
        // Falls back to the query-time read that was the only path before.
        let raw: string | null = null;
        try {
          raw = await readFile(abs, 'utf8');
        } catch {
          raw = null;
        }
        if (raw === null) bodiesEvicted += 1;
        else {
          try {
            text = latestUserText(JSON.parse(raw));
          } catch {
            text = null;
          }
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

/** `archive/<day>` → `<day>`; `null` for the live root or anything else. */
function archivedDayOf(sourceDir: string): string | null {
  return sourceDir.startsWith('archive/') ? sourceDir.slice('archive/'.length) : null;
}

/**
 * **The whole archive in one query**, bucketed into the reporting days it covers.
 *
 * This is what makes an all-time window a read rather than a walk. `readDir`
 * already filters by an indexed `source_dir` and an `id` range over the primary
 * key, so dropping the range and asking for every archived row costs one seek
 * instead of the two per day {@link SidecarSource.readArchivedDay} would issue —
 * and an all-time span is every day the corpus has.
 *
 * The bucketing is the walk's own rule, applied once instead of per day: a day
 * is read from `archive/<day>` and `archive/<day+1>`, keeping only rows whose
 * reporting day is that day, archived-directory-first so the stream stays in the
 * order the concatenation produced.
 */
async function readWholeArchive(
  db: DatabaseSync,
  logDir: string,
  days: readonly string[],
  opts: ReadOptions,
): Promise<Map<string, LoadResult>> {
  const wanted = new Set(days);
  const byDay = new Map<string, Entry[]>();

  for (const entry of entriesFrom(db, "source_dir <> ''", [], opts)) {
    const dir = archivedDayOf(entry.sourceDir);
    if (dir === null) continue;
    // The day this row would have been read under, if it is read at all.
    if (dir !== entry.day && dir !== shiftDay(entry.day, 1)) continue;
    if (!wanted.has(entry.day)) continue;
    const list = byDay.get(entry.day) ?? [];
    list.push(entry);
    byDay.set(entry.day, list);
  }

  const out = new Map<string, LoadResult>();
  for (const [day, list] of byDay) {
    const rank = (entry: Entry) => (archivedDayOf(entry.sourceDir) === day ? 0 : 1);
    // Ordered, the rank stops being the primary key and becomes the tie-break —
    // and it has to stay in that role, because the per-day walk this replaces
    // merges `<day>` and `<day+1>` and keeps `<day>` first on a tie. Dropping it
    // here would make the one-query read and the walk disagree about two rows
    // captured in the same millisecond on opposite sides of the archive seam.
    if (opts.orderByTimestamp) {
      list.sort(
        (a, b) =>
          (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0) ||
          rank(a) - rank(b) ||
          (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0),
      );
    } else list.sort((a, b) => rank(a) - rank(b) || (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0));
    // The day filter is already applied above, so nothing is left to reject.
    out.set(day, await materialize(logDir, list, null, opts));
  }
  return out;
}

/**
 * **One thread, off the thread index.** `request.thread_id` is indexed, so the
 * rows of one transcript are a seek; everything after it is the window's own
 * bookkeeping applied to that handful of rows rather than to the span.
 *
 * The span is resolved exactly as {@link readWindow} resolves it, and the two
 * day rules are the ones the window's halves already apply — {@link readDir}'s
 * `keepDay` for the live root, and the archive's "read `<day>` and `<day+1>`,
 * keep what reports `<day>`". Order is the concatenation's: archived halves in
 * day order, then the live root. That is what keeps this answer byte-identical
 * to the scan the file backing still does.
 */
async function threadFromDb(
  db: DatabaseSync,
  logDir: string,
  threadId: string,
  opts: WindowOptions,
  now: Date,
): Promise<ThreadReadResult> {
  // `archiveDir` is a file-backing concern; the substrate reads by `source_dir`.
  const { archiveDir: _archiveDir, all, ...requested } = opts;
  const bounded = requested.date || requested.since || requested.sinceDays != null;
  const floor = all && !bounded ? (oldestDayFromDb(db) ?? today(now)) : null;
  const readOpts: ReadOptions = floor === null ? requested : { ...requested, since: floor };
  const { date: _date, since: _since, sinceDays: _sinceDays, ...perFile } = readOpts;

  const { keepDay } = dayFilter(readOpts, now);
  const wanted = new Set(windowDays(readOpts, now));

  // `request_skipped` has no thread column, and nothing in it could: a file that
  // would not parse names no session. Selecting through the ids `request` holds
  // asks both tables the one question that has an answer, and leaves the skipped
  // half empty rather than erroring on a column that is not there.
  // Only `includeSkimRequests` is forwarded: it decides whether `skim_text` is
  // fetched, and the `materialize` below is handed the same flag through `perFile`.
  // `omitTools` is deliberately not passed — this read has always fetched the tools.
  const entries = entriesFrom(db, 'id IN (SELECT id FROM request WHERE thread_id = ?)', [threadId], {
    includeSkimRequests: readOpts.includeSkimRequests,
  });

  const archived: Entry[] = [];
  const live: Entry[] = [];
  for (const entry of entries) {
    const dir = archivedDayOf(entry.sourceDir);
    if (dir === null) {
      // Anything that is neither the live root nor an archived day was never in
      // the window's reach either.
      if (entry.sourceDir !== LIVE) continue;
      if (keepDay && !keepDay(entry.day)) continue;
      live.push(entry);
      continue;
    }
    if (dir !== entry.day && dir !== shiftDay(entry.day, 1)) continue;
    if (!wanted.has(entry.day)) continue;
    archived.push(entry);
  }

  const byStem = (a: Entry, b: Entry) => (a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0);
  const rank = (entry: Entry) => (archivedDayOf(entry.sourceDir) === entry.day ? 0 : 1);
  archived.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || rank(a) - rank(b) || byStem(a, b));
  live.sort(byStem);

  // The day filter is already applied above, so nothing is left to reject.
  const { sidecars, files } = await materialize(logDir, [...archived, ...live], null, perFile);
  return { sidecars, files, parseErrors: 0 };
}

/** `MIN(...)` over a TEXT column, aliased to `v`; null when no row matched. */
type MinTextRow = { v: string | null };

/**
 * The oldest day the substrate can answer for. `MIN` over the primary key and
 * over `source_dir` — both indexed, so this is a seek rather than a scan, and
 * neither is a guess: the id carries the file's UTC date prefix and the
 * `source_dir` carries the archive directory's name.
 *
 * One day back, for the same reason the file side steps back: a reporting day
 * lags the UTC day its files are named for.
 */
function oldestDayFromDb(db: DatabaseSync): string | null {
  const marks: string[] = [];
  const take = (value: string | null | undefined, from: number) => {
    if (value !== null && value !== undefined && value.length >= from + 10) marks.push(value.slice(from, from + 10));
  };
  // SAFETY: `request.id` is a TEXT primary key (see `open.ts`), so `MIN(id)` is
  // either that TEXT value or SQL NULL over an empty table — which is the
  // `string | null` in `MinTextRow`, and the `undefined` a missing row gives.
  const minRequestId = db.prepare('SELECT MIN(id) AS v FROM request').get() as MinTextRow | undefined;
  // SAFETY: same invariant — `request_skipped.id` is a TEXT primary key, so its
  // `MIN` is that TEXT value, SQL NULL, or no row at all.
  const minSkippedId = db.prepare('SELECT MIN(id) AS v FROM request_skipped').get() as MinTextRow | undefined;
  // SAFETY: same invariant — `request.source_dir` is a TEXT column, so its `MIN`
  // under this predicate is an `archive/<day>` string, SQL NULL, or no row at all.
  const minSourceDir = db.prepare("SELECT MIN(source_dir) AS v FROM request WHERE source_dir <> ''").get() as
    | MinTextRow
    | undefined;
  take(minRequestId?.v, 0);
  take(minSkippedId?.v, 0);
  take(minSourceDir?.v, 'archive/'.length);

  const earliest = marks.sort()[0];
  return earliest === undefined ? null : shiftDay(earliest, -1);
}

/* ------------------------------------------------------------------ *
 * Session transcripts
 * ------------------------------------------------------------------ */

type SessionRow = {
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
  parent_thread_id: string | null;
  spawn_index: number | null;
  spawn_agent_type: string | null;
};

type NodeRow = {
  thread_id: string;
  idx: number;
  type: string;
  text: string;
  tool: string | null;
  task: string | null;
  interruption: string | null;
  interrupted: number;
  message: number | null;
  turn: number | null;
  args_hash: string | null;
};

/** One `session` row reduced to the opening prompt the caller asked for. */
type RootPromptRow = { thread_id: string; root_prompt: string };

/** One `session` row reduced to the pull request it recorded. */
type PrLinkRow = { thread_id: string; pr_url: string };

/** A store row carried as the JSON document ingest read, rather than as columns. */
type DocumentRow = { document: string };

/** A `concept` row: its line in the file, and the document on that line. */
type ConceptRow = { ord: number; document: string };

/** One `session_node_text` row: the node's index and its untruncated text. */
type NodeTextRow = { idx: number; text: string };

/** A `file_watermark` row — the size and mtime a store was last ingested at. */
type WatermarkRow = { bytes: number; modified: string };

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
  // SAFETY: `session_node.type` and `session_node.interruption` are written by
  // ingest straight off a parsed `SessionNode`, so each column's value space is
  // exactly the union the node declares — the columns are a copy, not a re-encoding.
  return {
    index: row.idx,
    type: row.type as SessionNode['type'],
    text: row.text,
    tool: row.tool,
    task: row.task,
    interruption: row.interruption as SessionNode['interruption'],
    interrupted: row.interrupted === 1,
    message: row.message,
    turn: row.turn,
    argsHash: row.args_hash,
  };
}

/** The parentage the transcript recorded for itself, or null when it recorded none. */
function toRecordedSpawn(row: SessionRow): RecordedSpawn | null {
  if (!row.parent_thread_id) return null;
  return {
    parentThreadId: row.parent_thread_id,
    spawnIndex: row.spawn_index,
    agentType: row.spawn_agent_type,
  };
}

/** Bound parameters per statement, well under SQLite's ceiling on any build. */
const BIND_LIMIT = 500;

/**
 * The named threads' opening prompts, out of the column ingest copied them into.
 * Asked for by id rather than read wholesale, as the file reader is.
 */
function rootPromptsFromDb(db: DatabaseSync, threadIds: readonly string[]): Map<string, string> {
  const wanted = [...new Set(threadIds)].sort();
  const out = new Map<string, string>();

  for (let at = 0; at < wanted.length; at += BIND_LIMIT) {
    const chunk = wanted.slice(at, at + BIND_LIMIT);
    // SAFETY: the SELECT names exactly thread_id and root_prompt, and its own
    // predicate rejects the null and empty prompts — so every row carries the two
    // non-empty strings `RootPromptRow` declares.
    const rows = db
      .prepare(
        `SELECT thread_id, root_prompt FROM session
         WHERE root_prompt IS NOT NULL AND root_prompt != '' AND thread_id IN (${chunk.map(() => '?').join(',')})`,
      )
      .all(...chunk) as RootPromptRow[];
    for (const row of rows) out.set(row.thread_id, row.root_prompt);
  }
  return out;
}

/**
 * Every recorded pull request link, out of the column ingest copied it into. Unindexed but
 * tiny: the predicate keeps only the handful of threads that opened something.
 */
function prLinksFromDb(db: DatabaseSync): Map<string, string> {
  // SAFETY: the SELECT names exactly thread_id and pr_url, and its own predicate
  // rejects the null and empty urls — so every row carries the two non-empty
  // strings `PrLinkRow` declares.
  const rows = db
    .prepare("SELECT thread_id, pr_url FROM session WHERE pr_url IS NOT NULL AND pr_url != ''")
    .all() as PrLinkRow[];
  return new Map(rows.map((row) => [row.thread_id, row.pr_url]));
}

/** Newest first, ties broken by thread id — the order both listings return. */
function sortListing<T extends { modified: string; threadId: string }>(rows: T[]): T[] {
  rows.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  return rows;
}

const SESSION_COLUMNS =
  'thread_id, model, session_id, started, tasks, decisions, tools, errors, ' +
  'first_task, title, subtitle, derived_title, bytes, modified, ' +
  'parent_thread_id, spawn_index, spawn_agent_type';

function sessionRows(db: DatabaseSync): SessionRow[] {
  // SAFETY: `SESSION_COLUMNS` is the field list `SessionRow` declares, written out
  // in the same order — the one place either is edited is beside the other.
  return db.prepare(`SELECT ${SESSION_COLUMNS} FROM session`).all() as SessionRow[];
}

/** Every transcript's node stream, keyed by thread id and in transcript order. */
function nodesByThread(db: DatabaseSync): Map<string, SessionNode[]> {
  const out = new Map<string, SessionNode[]>();
  // SAFETY: the SELECT names exactly the eleven columns `NodeRow` declares, in that
  // order, so every row carries all of them.
  const rows = db
    .prepare(
      'SELECT thread_id, idx, type, text, tool, task, interruption, interrupted, message, turn, args_hash FROM session_node ORDER BY thread_id, idx',
    )
    .all() as NodeRow[];
  for (const row of rows) {
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
  // SAFETY: the SELECT names the single column `document`, so every row carries it.
  const rows = db.prepare('SELECT document FROM command_run ORDER BY ord').all() as DocumentRow[];
  // SAFETY: `command_run.document` is the verbatim line ingest read out of
  // `runs.jsonl`, and that store holds one serialized `CommandRun` per line — the
  // column is a copy of the record, not a re-encoding of it.
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
  // SAFETY: the SELECT names exactly ord and document, so every row carries both.
  const rows = db.prepare('SELECT ord, document FROM concept ORDER BY ord').all() as ConceptRow[];
  // `ord` comes off the row, not the loop index — it is the line's position in
  // the file, not this result set's.
  //
  // SAFETY: `concept.document` is the verbatim line ingest read out of
  // `concepts.jsonl`, and that store holds one serialized `Concept` per line — the
  // column is a copy of the record, not a re-encoding of it.
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
      const rows = sessionRows(db).map((row) => ({
        ...toSummary(row),
        nodes: nodes.get(row.thread_id) ?? [],
        recorded: toRecordedSpawn(row),
      }));
      // The agent tree is derived, not stored — same function the file reader
      // uses, over the same recorded parentage. `linkAgentSessions` sorts each
      // family internally, so the result does not depend on row order.
      const links = linkAgentSessions(rows);
      return sortListing(rows.map(({ recorded: _recorded, ...row }) => ({ ...row, ...links.get(row.threadId)! })));
    },
    readRootPrompts: async (_logDir, threadIds) => rootPromptsFromDb(db, threadIds),
    readPrLinks: async () => prLinksFromDb(db),
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

      // SAFETY: `SESSION_COLUMNS` is the field list `SessionRow` declares, and
      // `thread_id` is the table's primary key — so this is that row or no row.
      const row = db.prepare(`SELECT ${SESSION_COLUMNS} FROM session WHERE thread_id = ?`).get(id) as
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
      // SAFETY: the SELECT names exactly idx and text, so every row carries both.
      const rows = db
        .prepare('SELECT idx, text FROM session_node_text WHERE thread_id = ? ORDER BY idx')
        .all(id) as NodeTextRow[];
      for (const row of rows) {
        texts[row.idx] = row.text;
      }
      return { threadId: id, texts };
    },
    // The store is indexed whole, so this reads no file at all — beyond the one
    // `stat` below.
    readCommandRuns: async (logDir) => {
      // The server reconciles the store and reads it back inside the same
      // request, so rows behind the file would answer with the pre-reconcile
      // view. Same watermark equality `ingestCommandRuns` uses; anything else
      // re-reads the store, which is what the file reader would have answered.
      // `syncCommandRuns` below is what makes the equality reachable here at all:
      // the reconcile's own append moves both halves of it, so without the fold this
      // route always fell through to the parse.
      // SAFETY: the SELECT names exactly bytes and modified, and `path` is the
      // watermark table's key — so this is that store's row or no row at all.
      const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(COMMAND_STORE_PATH) as
        | WatermarkRow
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
    // Async to match the seam; the work itself is synchronous SQLite.
    syncCommandRuns: async (_logDir, append) => applyCommandRunAppend(db, append),
    // The store is indexed whole, so this reads no file at all — as long as the
    // rows are provably current. `/teach` appends from outside the server, so a
    // record can land between two ingest passes; the same watermark equality
    // `ingestConcepts` uses decides, and anything else re-reads the file, which
    // is what the file reader would have answered.
    readConcepts: async (logDir) => {
      // SAFETY: the SELECT names exactly bytes and modified, and `path` is the
      // watermark table's key — so this is that store's row or no row at all.
      const mark = db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(CONCEPT_STORE_PATH) as
        | WatermarkRow
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
    readThread: async (logDir, threadId, opts = {}, now = new Date()) => threadFromDb(db, logDir, threadId, opts, now),
    oldestDay: async () => oldestDayFromDb(db),
    readAllDays: async (logDir, days, opts = {}) => {
      // `archiveDir` is a file-backing concern; the substrate reads by `source_dir`.
      const { archiveDir: _archiveDir, ...readOpts } = opts;
      return readWholeArchive(db, logDir, days, readOpts);
    },
    readArchivedDay: async (logDir, date, opts = {}) => {
      // `archiveDir` is a file-backing concern; the substrate reads by `source_dir`.
      const { archiveDir: _archiveDir, ...readOpts } = opts;
      const out: LoadResult = { sidecars: [], files: 0, parseErrors: 0, bodiesEvicted: 0 };
      // Archive folders are named for the UTC day the summary job moved, so one
      // reporting day straddles two of them. Read both, keep only `date`.
      for (const day of [date, shiftDay(date, 1)]) {
        const r = await readDir(db, logDir, `archive/${day}`, { ...readOpts, date }, new Date());
        // Same merge the file backing does across the same two directories, and
        // for the same reason: the halves interleave in time, and `<day>` stays
        // first on a tie so the stream is the concatenation's.
        if (readOpts.orderByTimestamp) out.sidecars = mergeByTimestamp(out.sidecars, r.sidecars);
        else out.sidecars.push(...r.sidecars);
        out.files += r.files;
        out.parseErrors += r.parseErrors;
        out.bodiesEvicted = (out.bodiesEvicted ?? 0) + (r.bodiesEvicted ?? 0);
      }
      return out;
    },
  };
}
