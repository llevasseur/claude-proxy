import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type AuditSidecar, isAuditSidecar, reportDay, shiftDay } from "@claude-proxy/core";

export { shiftDay };

/** The sidecar suffix, which retention keeps forever. */
const AUDIT_SUFFIX = ".audit.json";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // server/src

/** Repo-root `logs/` — where the proxy writes its sidecars by default. */
export const DEFAULT_LOG_DIR = path.resolve(HERE, "../../logs");

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
  return entries.filter((f) => f.endsWith(".audit.json")).length;
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
}

function latestUserText(request: unknown): string | null {
  if (typeof request !== "object" || request === null) return null;
  const messages = (request as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message?.role !== "user") continue;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) continue;
    const text = message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }
  return null;
}

/**
 * The last user turn from a captured body, plus whether the body was on disk at
 * all. A body that parsed but holds no user text yields `null` text with
 * `bodyPresent: true`; only `bodyPresent: false` counts as an eviction. Both read
 * backings must draw that line in the same place or `/api/skim` loses parity.
 */
async function skimRequestText(logDir: string, auditFile: string): Promise<{ text: string | null; bodyPresent: boolean }> {
  const requestFile = auditFile.replace(/\.audit\.json$/, ".request.txt");
  let raw: string;
  try {
    raw = await readFile(path.join(logDir, requestFile), "utf8");
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

/** A sidecar's ISO `timestamp`, when it has a usable one. */
function timestampOf(sidecar: unknown): string | null {
  if (typeof sidecar !== "object" || sidecar === null) return null;
  const ts = (sidecar as { timestamp?: unknown }).timestamp;
  return typeof ts === "string" ? ts : null;
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
  } catch (err) {
    throw new Error(`cannot read log directory ${logDir}: ${(err as Error).message}`);
  }

  let files = entries.filter((f) => f.endsWith(".audit.json"));
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
  let parseErrors = 0;
  let kept = 0;
  let bodiesEvicted = 0;
  for (const f of files) {
    let sidecar: unknown;
    try {
      sidecar = JSON.parse(await readFile(path.join(logDir, f), "utf8")) as unknown;
    } catch {
      // No timestamp to place it by, so fall back to the filename's UTC day.
      if (keepDay && !keepDay(f.slice(0, 10))) continue;
      parseErrors += 1;
      kept += 1;
      sidecars.push({ __parseError: f });
      continue;
    }

    if (keepDay) {
      const ts = timestampOf(sidecar);
      if (!keepDay((ts && reportDay(ts)) || f.slice(0, 10))) continue;
    }

    if (typeof sidecar === "object" && sidecar !== null) {
      if (opts.includeSkimRequests) {
        const { text, bodyPresent } = await skimRequestText(logDir, f);
        (sidecar as { skimRequestText?: string }).skimRequestText = text ?? undefined;
        if (!bodyPresent) bodiesEvicted += 1;
      }
      if (opts.includeFile) {
        (sidecar as { __file?: string }).__file = f.replace(/\.audit\.json$/, "");
      }
    }
    kept += 1;
    sidecars.push(sidecar);
  }
  return { sidecars, files: kept, parseErrors, bodiesEvicted };
}

/** `<logDir>/archive/<YYYY-MM-DD>/` — where the summary job parks each past day's sidecars. */
export function rawArchiveDayDir(logDir: string, date: string): string {
  return path.join(logDir, "archive", date);
}

/**
 * One archived day's sidecars from `<logDir>/archive/<date>/`. Empty result rather
 * than a throw when the day was never archived or has been pruned.
 *
 * Folders are named for the UTC day the job moved, so a reporting day straddles
 * `date` and `date + 1`; both are read and `readSidecars` keeps only the
 * sidecars that land on `date`.
 */
export async function readArchivedDay(
  logDir: string,
  date: string,
  opts: Omit<ReadOptions, "date" | "sinceDays"> = {},
): Promise<LoadResult> {
  const out: LoadResult = { sidecars: [], files: 0, parseErrors: 0, bodiesEvicted: 0 };
  for (const day of [date, shiftDay(date, 1)]) {
    try {
      const r = await readSidecars(rawArchiveDayDir(logDir, day), { ...opts, date });
      out.sidecars.push(...r.sidecars);
      out.files += r.files;
      out.parseErrors += r.parseErrors;
      out.bodiesEvicted = (out.bodiesEvicted ?? 0) + (r.bodiesEvicted ?? 0);
    } catch {
      // Never archived or already pruned — contributes nothing.
    }
  }
  return out;
}

/** Base names the proxy emits, e.g. `2026-07-20T13-31-00-278_anthropic`. Digits,
 * `T`, `:` (legacy), `.`, `_`, `-` only — no path separators, no `..`. */
const REQUEST_FILE_RE = /^[0-9A-Za-z:_.\-]+_anthropic$/;

/**
 * Read and parse one captured request body, without rendering it for display.
 *
 * Validates `file` against {@link REQUEST_FILE_RE} and confirms the resolved path stays
 * inside `logDir` before touching the disk — the base name comes from the client, so
 * path traversal must be impossible. Callers that only need the parsed object use this
 * rather than {@link readRequestBody}, whose pretty-printing doubles the cost of a
 * multi-megabyte body; the commands reconcile pass opens bodies in bulk.
 */
export async function readRequestBodyParsed(logDir: string, file: string): Promise<unknown> {
  const live = liveRequestPath(logDir, file);

  // Fast path: today's bodies are all live. Kept to a single read with no `stat`
  // in front of it — the commands reconcile pass opens bodies by the thousand.
  let text: string | null = null;
  try {
    text = await readFile(live, "utf8");
  } catch {
    text = null;
  }
  if (text !== null) return JSON.parse(text) as unknown;

  // Slow path: archived, evicted, or never captured.
  const location = await locateRequestBody(logDir, file);
  if (location.status === "present") return JSON.parse(await readFile(location.path, "utf8")) as unknown;
  if (location.status === "evicted") throw new Error(`request body evicted: ${file}`);
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
  | { status: "present"; dir: string; path: string }
  | { status: "evicted"; dir: string; day: string | null }
  | { status: "missing" };

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
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) dirs.push({ dir: path.join(root, "archive", day), day });
  return dirs;
}

/** Locate one request's body. `file` is validated exactly as for a direct read. */
export async function locateRequestBody(logDir: string, file: string): Promise<RequestBodyLocation> {
  liveRequestPath(logDir, file); // validates `file`; the path itself is re-derived below
  let sidecar: { dir: string; day: string | null } | null = null;

  for (const candidate of requestDirs(logDir, file)) {
    const body = path.join(candidate.dir, `${file}.request.txt`);
    if (await exists(body)) return { status: "present", dir: candidate.dir, path: body };
    if (!sidecar && (await exists(path.join(candidate.dir, `${file}${AUDIT_SUFFIX}`)))) sidecar = candidate;
  }

  if (sidecar) return { status: "evicted", dir: sidecar.dir, day: sidecar.day };
  return { status: "missing" };
}

/**
 * The audit sidecar that outlived an evicted body. Returns `null` when it is
 * unreadable or malformed, so a caller reporting an eviction never fails on it.
 */
export async function readRetainedSidecar(logDir: string, file: string, dir: string): Promise<AuditSidecar | null> {
  if (!REQUEST_FILE_RE.test(file)) return null;
  try {
    const raw: unknown = JSON.parse(await readFile(path.join(dir, `${file}${AUDIT_SUFFIX}`), "utf8"));
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
