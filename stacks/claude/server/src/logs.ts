import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type AuditSidecar, isAuditSidecar, reportDay, shiftDay } from '@agent-proxy/claude-core';
import { latestUserText } from './derive.js';
import { errorMessage } from './errors.js';
import { type JsonInput, type JsonObject, type JsonValue, jsonArray, jsonObject, stringField } from './json.js';

export { shiftDay };

/** The sidecar suffix, which retention keeps forever. */
const AUDIT_SUFFIX = '.audit.json';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src

/** Repo-root `logs/` — where the proxy writes its sidecars by default. */
export const DEFAULT_LOG_DIR = path.resolve(HERE, '../../logs');

/** Resolve the log directory: `LOG_DIR` env override, else the repo-root default. */
export function resolveLogDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOG_DIR ? path.resolve(env.LOG_DIR) : DEFAULT_LOG_DIR;
}

export interface LoadResult {
  /** Parsed sidecar objects (untrusted — validated downstream by the digest). */
  sidecars: unknown[];
  /** Number of `*.audit.json` files matched. */
  files: number;
  /** Files that failed to JSON-parse (already reflected as skipped in the digest). */
  parseErrors: number;
  /**
   * Sidecars here whose `.request.txt` body is no longer on disk. Only counted
   * when the read asked for the bodies (`includeSkimRequests`); otherwise 0 means
   * "not measured" rather than "none".
   */
  bodiesEvicted?: number;
}

/** Count `*.audit.json` files without reading their contents (for health). */
export async function countSidecarFiles(logDir: string): Promise<number> {
  const entries = await readdir(logDir);
  return entries.filter((f) => f.endsWith('.audit.json')).length;
}

export interface ReadOptions {
  /** Only sidecars whose reporting-zone day equals this `YYYY-MM-DD`. */
  date?: string;
  /** Only sidecars on/after this reporting-zone `YYYY-MM-DD`. Ignored if `date` is set. */
  since?: string;
  /** Only sidecars on/after (today − sinceDays + 1). Ignored if `date` or `since` is set. */
  sinceDays?: number;
  includeSkimRequests?: boolean;
  /** Attach `__file` (the sidecar base name, minus `.audit.json`) to each parsed
   * object so callers can map a sidecar back to its raw request file. */
  includeFile?: boolean;
  /**
   * The caller reads `request.toolCount` and nothing from the per-tool list, so
   * every sidecar comes back with an **empty** `tools` array.
   *
   * It stays an array rather than being dropped, because `isAuditSidecar` in
   * `packages/core` requires one — a missing key would make every row of the
   * window fail the structural guard and vanish from the answer.
   *
   * **Both backings honour it**, though only one of them saves anything by it.
   * The SQLite backing skips the `request_tool` join entirely, which is the
   * point: a 30-day window is tens of thousands of requests, each carrying tens
   * of tool schemas that were fetched, grouped and rebuilt for a caller that
   * never looked. The file backing has already parsed the whole sidecar off
   * disk, so emptying the array buys it nothing — it does it anyway so the two
   * backings keep handing callers the same object, which is what the parity
   * harness rests on.
   */
  omitTools?: boolean;
  /**
   * Deliver the window in **timestamp order** rather than in the order the two
   * halves happen to be read in.
   *
   * Without it a window arrives archived-half-first, then the live root — which
   * is chronological everywhere except the seam, because a reporting day near
   * the present genuinely sits in both places. A caller that wants chronology
   * therefore sorts the whole window itself, and on a 30-day span that is a
   * ~630,000-comparison sort of 41,000 rows for an order the substrate can seek.
   *
   * The order is `(timestamp, stem)`. The stem breaks ties so the two backings
   * cannot disagree on same-instant rows, and a row with **no** timestamp — a
   * file that would not parse, which has no `timestamp` to read — sorts as the
   * empty string, ahead of every real one. Both backings apply that identical
   * rule; only the substrate saves anything by the flag, exactly as with
   * {@link ReadOptions.omitTools}, since the file backing has to parse the
   * whole window off disk before it knows a single timestamp.
   */
  orderByTimestamp?: boolean;
}

/**
 * The last user turn from a captured body, plus whether the body was on disk at
 * all. A body that parsed but holds no user text yields `null` text with
 * `bodyPresent: true`; only `bodyPresent: false` counts as an eviction. Both read
 * backings must draw that line in the same place or `/api/skim` loses parity.
 */
async function skimRequestText(
  logDir: string,
  auditFile: string,
): Promise<{ text: string | null; bodyPresent: boolean }> {
  const requestFile = auditFile.replace(/\.audit\.json$/, '.request.txt');
  let raw: string;
  try {
    raw = await readFile(path.join(logDir, requestFile), 'utf8');
  } catch {
    return { text: null, bodyPresent: false };
  }
  try {
    return { text: latestUserText(JSON.parse(raw)), bodyPresent: true };
  } catch {
    return { text: null, bodyPresent: true };
  }
}

/** `YYYY-MM-DD` for today in the reporting zone (see `REPORT_TZ`). */
export function today(now: Date = new Date()): string {
  return reportDay(now) ?? now.toISOString().slice(0, 10);
}

function cutoff(sinceDays: number, now: Date): string {
  return shiftDay(today(now), -(sinceDays - 1));
}

/** `<stem>.audit.json` -> `<stem>`, the name both backings key a row by. */
function stemOf(file: string): string {
  return file.replace(/\.audit\.json$/, '');
}

/**
 * The window's total order, as a tuple rather than a joined string so no
 * separator character has to sort below every character a stem can hold.
 *
 * Timestamp first, stem second. The stem is what stops the two backings from
 * disagreeing about rows captured in the same millisecond, and an absent
 * timestamp is the empty string, which sorts ahead of every real one.
 */
export function compareByTimestamp(
  a: { timestamp: string; stem: string },
  b: { timestamp: string; stem: string },
): number {
  if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
  return a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0;
}

/**
 * Two already-ordered halves of a window, merged into one ordered stream in a
 * single linear pass — no sort, which is the entire point of asking for the
 * order at the read.
 *
 * **Ties keep `a` first**, and that is what makes this a no-op rewrite of the
 * concatenation it replaces: the halves are handed over in exactly the order
 * they used to be appended in (an archived day before the day after it, the
 * archived stream before the live root), so two rows the timestamps cannot
 * separate come out in the order they always did.
 */
export function mergeByTimestamp(a: readonly unknown[], b: readonly unknown[]): unknown[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  const out: unknown[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    // SAFETY: a half of a window is what `readSidecars` pushed — each row is the
    // output of the `JSON.parse` below, so it is a `JsonValue` by construction.
    const left = timestampOf(a[i] as JsonInput) ?? '';
    // SAFETY: `b`'s rows come from the same reader as `a`'s, on the same terms.
    const right = timestampOf(b[j] as JsonInput) ?? '';
    if (right < left) {
      out.push(b[j]!);
      j += 1;
    } else {
      out.push(a[i]!);
      i += 1;
    }
  }
  for (; i < a.length; i += 1) out.push(a[i]!);
  for (; j < b.length; j += 1) out.push(b[j]!);
  return out;
}

/** A sidecar's ISO `timestamp`, when it has a usable one. */
function timestampOf(sidecar: JsonInput): string | null {
  return stringField(sidecar, 'timestamp') ?? null;
}

/**
 * The keys this reader writes onto a parsed sidecar before handing it on.
 *
 * They are not part of the captured document, which is why they are named here
 * rather than found by decoding: `skimRequestText` is written as `undefined`
 * when the body held no user text — a key present with no value, which is what
 * `JSON.stringify` and the substrate's own rows already agree means "none".
 */
interface ReaderFields {
  skimRequestText?: string | undefined;
  tools?: JsonValue[];
  __file?: string;
}

/**
 * Read audit sidecars from `logDir`, filtered by date/window. A file that
 * fails to parse is counted in `parseErrors` and pushed as an invalid marker so
 * the digest tallies it under `skipped` rather than dropping it silently.
 * Throws only if the directory itself cannot be read.
 */
export async function readSidecars(
  logDir: string,
  opts: ReadOptions = {},
  now: Date = new Date(),
): Promise<LoadResult> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch (cause) {
    throw new Error(`cannot read log directory ${logDir}: ${errorMessage(cause)}`);
  }

  let files = entries.filter((f) => f.endsWith('.audit.json'));
  // Filenames carry the proxy's UTC prefix, so one reporting day spans the
  // filenames `D` and `D+1`. Match a superset by filename, then narrow it
  // exactly by each sidecar's own timestamp.
  let keepDay: ((day: string) => boolean) | null = null;
  if (opts.date) {
    const next = shiftDay(opts.date, 1);
    files = files.filter((f) => f.startsWith(opts.date!) || f.startsWith(next));
    keepDay = (day) => day === opts.date;
  } else if (opts.since) {
    files = files.filter((f) => f.slice(0, 10) >= opts.since!);
    keepDay = (day) => day >= opts.since!;
  } else if (opts.sinceDays != null) {
    const from = cutoff(opts.sinceDays, now);
    files = files.filter((f) => f.slice(0, 10) >= from);
    keepDay = (day) => day >= from;
  }
  files.sort();

  const sidecars: unknown[] = [];
  // Parallel to `sidecars`, and only read when `orderByTimestamp` asks for it:
  // the `(timestamp, stem)` key of each row, in the filename order they were
  // pushed in. Kept alongside rather than folded into the rows because a
  // sidecar is handed to callers as it was parsed, with nothing added to it.
  const keys: Array<{ timestamp: string; stem: string }> = [];
  let parseErrors = 0;
  let kept = 0;
  let bodiesEvicted = 0;
  for (const f of files) {
    let sidecar: JsonValue;
    try {
      // SAFETY: `JSON.parse` is declared `any`, but every value it can return is
      // within `JsonValue` by construction — that is the whole value space of a
      // parsed document, and the readers below take it one step at a time.
      sidecar = JSON.parse(await readFile(path.join(logDir, f), 'utf8')) as JsonValue;
    } catch {
      // No timestamp to place it by, so fall back to the filename's UTC day.
      if (keepDay && !keepDay(f.slice(0, 10))) continue;
      parseErrors += 1;
      kept += 1;
      sidecars.push({ __parseError: f });
      // No timestamp to order by — the file did not parse. The empty key is the
      // rule the substrate applies to its skipped rows too.
      keys.push({ timestamp: '', stem: stemOf(f) });
      continue;
    }

    if (keepDay) {
      const ts = timestampOf(sidecar);
      if (!keepDay((ts && reportDay(ts)) || f.slice(0, 10))) continue;
    }

    const record = jsonObject(sidecar);
    if (record !== undefined) {
      // SAFETY: `record` is the object `jsonObject` just narrowed, and this view
      // adds only the three keys above — none of them a field the proxy writes,
      // so nothing in the captured document is being retyped.
      const decorated = record as JsonObject & ReaderFields;
      if (opts.includeSkimRequests) {
        const { text, bodyPresent } = await skimRequestText(logDir, f);
        decorated.skimRequestText = text ?? undefined;
        if (!bodyPresent) bodiesEvicted += 1;
      }
      if (opts.omitTools && jsonArray(record.tools) !== undefined) {
        decorated.tools = [];
      }
      if (opts.includeFile) {
        decorated.__file = f.replace(/\.audit\.json$/, '');
      }
    }
    kept += 1;
    sidecars.push(sidecar);
    keys.push({ timestamp: timestampOf(sidecar) ?? '', stem: stemOf(f) });
  }

  if (opts.orderByTimestamp) {
    // Sorting the index rather than the rows keeps the two arrays in step, and
    // the file backing pays this sort in full: it has no index to seek, which
    // is the whole reason the flag exists for the substrate's sake.
    const order = keys.map((_, i) => i);
    order.sort((a, b) => compareByTimestamp(keys[a]!, keys[b]!));
    return { sidecars: order.map((i) => sidecars[i]), files: kept, parseErrors, bodiesEvicted };
  }
  return { sidecars, files: kept, parseErrors, bodiesEvicted };
}

/** `<logDir>/archive/<YYYY-MM-DD>/` — where the summary job parks each past day's sidecars. */
export function rawArchiveDayDir(logDir: string, date: string): string {
  return path.join(logDir, 'archive', date);
}

/**
 * `<archiveDir>/<YYYY-MM-DD>/raw/` — where a finished day's raw triples end up
 * once they are relocated off the log volume, alongside that day's `digest.json`.
 * The relocation is external to this repo, so `<logDir>/archive/<date>/` is empty
 * on a deployment that runs it.
 */
export function relocatedArchiveDayDir(archiveDir: string, date: string): string {
  return path.join(archiveDir, date, 'raw');
}

export interface ArchivedDayOptions extends Omit<ReadOptions, 'date' | 'sinceDays'> {
  /**
   * Root of the relocated archive (see {@link relocatedArchiveDayDir}), read as a
   * fallback for a day no longer under `<logDir>/archive/`.
   */
  archiveDir?: string;
}

/**
 * One archived day's sidecars, from `<logDir>/archive/<date>/` and — for a day
 * that has since been relocated — `<archiveDir>/<date>/raw/`. Empty result rather
 * than a throw when the day was never archived or has been pruned.
 *
 * Folders are named for the UTC day the job moved, so a reporting day straddles
 * `date` and `date + 1`; both are read and `readSidecars` keeps only the
 * sidecars that land on `date`.
 *
 * The two roots are tried per folder rather than merged: relocation *moves* the
 * triples, so a folder present in both would double every request in it.
 */
export async function readArchivedDay(
  logDir: string,
  date: string,
  opts: ArchivedDayOptions = {},
): Promise<LoadResult> {
  const { archiveDir, ...readOpts } = opts;
  const out: LoadResult = { sidecars: [], files: 0, parseErrors: 0, bodiesEvicted: 0 };
  for (const day of [date, shiftDay(date, 1)]) {
    const roots = [rawArchiveDayDir(logDir, day)];
    if (archiveDir) roots.push(relocatedArchiveDayDir(archiveDir, day));
    for (const root of roots) {
      let r: LoadResult;
      try {
        r = await readSidecars(root, { ...readOpts, date });
      } catch {
        // Never archived, already pruned, or relocated away — try the next root.
        continue;
      }
      if (r.files === 0) continue;
      // A reporting day is read from `<day>` and `<day+1>`, so the two halves
      // interleave in time. Concatenating them was fine while the caller sorted;
      // an ordered read has to merge them, `<day>` first on a tie so the stream
      // is the one the concatenation produced.
      if (readOpts.orderByTimestamp) out.sidecars = mergeByTimestamp(out.sidecars, r.sidecars);
      else out.sidecars.push(...r.sidecars);
      out.files += r.files;
      out.parseErrors += r.parseErrors;
      out.bodiesEvicted = (out.bodiesEvicted ?? 0) + (r.bodiesEvicted ?? 0);
      break;
    }
  }
  return out;
}

/** Base names the proxy emits, e.g. `2026-07-20T13-31-00-278_anthropic`. Digits,
 * `T`, `:` (legacy), `.`, `_`, `-` only — no path separators, no `..`. */
const REQUEST_FILE_RE = /^[0-9A-Za-z:_.-]+_anthropic$/;

/**
 * Read and parse one captured request body, without rendering it for display.
 *
 * Validates `file` against {@link REQUEST_FILE_RE} and confirms the resolved path stays
 * inside `logDir` before touching the disk — the base name comes from the client, so
 * path traversal must be impossible. Callers that only need the parsed object use this
 * rather than {@link readRequestBody}, whose pretty-printing doubles the cost of a
 * multi-megabyte body; the commands reconcile pass opens bodies in bulk.
 */
export async function readRequestBodyParsed(logDir: string, file: string): Promise<JsonValue> {
  const live = liveRequestPath(logDir, file);

  // Fast path: today's bodies are all live. Kept to a single read with no `stat`
  // in front of it — the commands reconcile pass opens bodies by the thousand.
  let text: string | null = null;
  try {
    text = await readFile(live, 'utf8');
  } catch {
    text = null;
  }
  if (text !== null) {
    // SAFETY: as in `readSidecars` — `JSON.parse` is declared `any`, and every
    // value it returns is within `JsonValue`. A body that will not parse throws
    // out of here, which is the read failure the callers already handle.
    return JSON.parse(text) as JsonValue;
  }

  // Slow path: archived, evicted, or never captured.
  const location = await locateRequestBody(logDir, file);
  if (location.status === 'present') {
    // SAFETY: the archived copy is the same captured body as the live one above.
    return JSON.parse(await readFile(location.path, 'utf8')) as JsonValue;
  }
  if (location.status === 'evicted') throw new Error(`request body evicted: ${file}`);
  throw new Error(`request file not found: ${file}`);
}

/** The live directory's path for a request body, with `file` validated. */
function liveRequestPath(logDir: string, file: string): string {
  if (!REQUEST_FILE_RE.test(file)) {
    throw new Error(`invalid request file name: ${file}`);
  }
  const full = path.resolve(logDir, `${file}.request.txt`);
  if (path.dirname(full) !== path.resolve(logDir)) {
    throw new Error(`invalid request file name: ${file}`);
  }
  return full;
}

/** Whether a path exists and is readable. Never throws. */
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where one captured request's files are, and what state the body is in.
 *
 * - `present` — the body is on disk, live or in its archived day.
 * - `evicted` — the sidecar is retained but the body is gone. Expected and
 *   permanent, not a fault.
 * - `missing` — neither file is there. The only case worth a 404.
 */
export type RequestBodyLocation =
  | { status: 'present'; dir: string; path: string }
  | { status: 'evicted'; dir: string; day: string | null }
  | { status: 'missing' };

/**
 * The directories a request's files can live in, in lookup order: the live
 * directory, then `archive/<day>/` for the day its filename carries. Archiving
 * files a log under its own date prefix, so there is exactly one archive
 * candidate and no scan.
 */
function requestDirs(logDir: string, file: string): { dir: string; day: string | null }[] {
  const root = path.resolve(logDir);
  const dirs: { dir: string; day: string | null }[] = [{ dir: root, day: null }];
  const day = file.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dirs.push({ dir: path.join(root, 'archive', day), day });
  return dirs;
}

/** Locate one request's body. `file` is validated exactly as for a direct read. */
export async function locateRequestBody(logDir: string, file: string): Promise<RequestBodyLocation> {
  liveRequestPath(logDir, file); // validates `file`; the path itself is re-derived below
  let sidecar: { dir: string; day: string | null } | null = null;

  for (const candidate of requestDirs(logDir, file)) {
    const body = path.join(candidate.dir, `${file}.request.txt`);
    if (await exists(body)) return { status: 'present', dir: candidate.dir, path: body };
    if (!sidecar && (await exists(path.join(candidate.dir, `${file}${AUDIT_SUFFIX}`)))) sidecar = candidate;
  }

  if (sidecar) return { status: 'evicted', dir: sidecar.dir, day: sidecar.day };
  return { status: 'missing' };
}

/**
 * The audit sidecar that outlived an evicted body. Returns `null` when it is
 * unreadable or malformed, so a caller reporting an eviction never fails on it.
 * `_logDir` is unread — the sidecar is found under `dir` — but kept for signature
 * parity with the other readers here.
 */
export async function readRetainedSidecar(_logDir: string, file: string, dir: string): Promise<AuditSidecar | null> {
  if (!REQUEST_FILE_RE.test(file)) return null;
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, `${file}${AUDIT_SUFFIX}`), 'utf8'));
    return isAuditSidecar(raw) ? raw : null;
  } catch {
    return null;
  }
}

export interface RequestBodyResult {
  /** The parsed request body (untrusted — analyzed downstream). */
  body: unknown;
  /** The raw request text, pretty-printed, capped at `maxRawBytes`. */
  raw: string;
  /** True when `raw` was truncated to fit the cap. */
  truncated: boolean;
}

/**
 * Read and parse a single captured request body by its sidecar base name.
 * Validates `file` against {@link REQUEST_FILE_RE} and confirms the resolved
 * path stays inside `logDir` before touching the disk — the base name comes
 * from the client, so path traversal must be impossible. Throws a labelled
 * error the server maps to 400 (bad name) / 404 (missing file).
 */
export async function readRequestBody(
  logDir: string,
  file: string,
  maxRawBytes = 2_000_000,
): Promise<RequestBodyResult> {
  const body = await readRequestBodyParsed(logDir, file);
  const pretty = JSON.stringify(body, null, 2);
  const truncated = pretty.length > maxRawBytes;
  return { body, raw: truncated ? pretty.slice(0, maxRawBytes) : pretty, truncated };
}
