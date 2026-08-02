import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { reportDay } from "@claude-proxy/core";
import {
  readArchivedDay as readArchivedDayFromFiles,
  readSidecars as readSidecarsFromFiles,
  shiftDay,
  today,
  type LoadResult,
  type ReadOptions,
} from "../logs.js";

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
  readonly kind: "files" | "db";
  readSidecars(logDir: string, opts?: ReadOptions, now?: Date): Promise<LoadResult>;
  readArchivedDay(logDir: string, date: string, opts?: Omit<ReadOptions, "date" | "sinceDays">): Promise<LoadResult>;
}

/** The behaviour the server has today: scan the directory, parse every file. */
export const fileSource: SidecarSource = {
  kind: "files",
  readSidecars: (logDir, opts, now) => readSidecarsFromFiles(logDir, opts, now),
  readArchivedDay: (logDir, date, opts) => readArchivedDayFromFiles(logDir, date, opts),
};

/** The live log directory's `source_dir`; archived days are `archive/<YYYY-MM-DD>`. */
const LIVE = "";

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
function dayFilter(opts: ReadOptions, now: Date): { keepDay: ((day: string) => boolean) | null; from: string | null; to: string | null } {
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
  const where: string[] = ["source_dir = ?"];
  const args: unknown[] = [sourceDir];
  if (from) {
    where.push("id >= ?");
    args.push(from);
  }
  if (to) {
    where.push("id < ?");
    args.push(to);
  }
  const clause = where.join(" AND ");

  const rows = db.prepare(`SELECT * FROM request WHERE ${clause} ORDER BY id`).all(...(args as never[])) as unknown as RequestRow[];
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
      const holes = chunk.map(() => "?").join(",");
      for (const t of db
        .prepare(`SELECT request_id, name, bytes, est_tokens FROM request_tool WHERE request_id IN (${holes}) ORDER BY request_id, ord`)
        .all(...(chunk as never[])) as unknown as Array<{ request_id: string; name: string; bytes: number; est_tokens: number }>) {
        const list = toolsById.get(t.request_id) ?? [];
        list.push({ name: t.name, bytes: t.bytes, est_tokens: t.est_tokens });
        toolsById.set(t.request_id, list);
      }
      for (const h of db
        .prepare(
          `SELECT request_id, header_name, header_value FROM request_rate_limit WHERE request_id IN (${holes}) ORDER BY request_id, ord`,
        )
        .all(...(chunk as never[])) as unknown as Array<{ request_id: string; header_name: string; header_value: string }>) {
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
    const parseError = row.reason === "parse_error";
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
  for (const entry of entries) {
    if (keepDay && !keepDay(entry.day)) continue;
    const sidecar = entry.make();
    if (entry.parseError) parseErrors += 1;
    if (opts.includeSkimRequests && !entry.parseError) {
      // The bodies stay on disk; the DB holds a pointer, not the blob.
      const rel = sourceDir === LIVE ? `${entry.stem}.request.txt` : `${sourceDir}/${entry.stem}.request.txt`;
      let text: string | null = null;
      try {
        text = latestUserText(JSON.parse(await readFile(path.join(logDir, rel), "utf8")));
      } catch {
        text = null;
      }
      sidecar.skimRequestText = text ?? undefined;
    }
    if (opts.includeFile) sidecar.__file = entry.stem;
    kept += 1;
    sidecars.push(sidecar);
  }
  return { sidecars, files: kept, parseErrors };
}

/** The same reads, answered from the substrate. */
export function dbSource(db: DatabaseSync): SidecarSource {
  return {
    kind: "db",
    readSidecars: (logDir, opts = {}, now = new Date()) => readDir(db, logDir, LIVE, opts, now),
    readArchivedDay: async (logDir, date, opts = {}) => {
      const out: LoadResult = { sidecars: [], files: 0, parseErrors: 0 };
      // Archive folders are named for the UTC day the summary job moved, so one
      // reporting day straddles two of them. Read both, keep only `date`.
      for (const day of [date, shiftDay(date, 1)]) {
        const r = await readDir(db, logDir, `archive/${day}`, { ...opts, date }, new Date());
        out.sidecars.push(...r.sidecars);
        out.files += r.files;
        out.parseErrors += r.parseErrors;
      }
      return out;
    },
  };
}
