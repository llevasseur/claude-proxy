import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
}

/** Count `*.audit.json` files without reading their contents (for health). */
export async function countSidecarFiles(logDir: string): Promise<number> {
  const entries = await readdir(logDir);
  return entries.filter((f) => f.endsWith(".audit.json")).length;
}

export interface ReadOptions {
  /** Only files whose filename date prefix equals this `YYYY-MM-DD`. */
  date?: string;
  /** Only files on/after (today − sinceDays + 1). Ignored if `date` is set. */
  sinceDays?: number;
  /** Enrich skim records with the latest user-authored text from the sibling request log. */
  includeSkimRequests?: boolean;
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

async function skimRequestText(logDir: string, auditFile: string): Promise<string | null> {
  const requestFile = auditFile.replace(/\.audit\.json$/, ".request.txt");
  try {
    return latestUserText(JSON.parse(await readFile(path.join(logDir, requestFile), "utf8")));
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` for today (UTC), matching the proxy's ISO filename prefixes. */
export function today(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` for `n` days before `from` (UTC). */
export function shiftDay(from: string, n: number): string {
  const d = new Date(`${from}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function cutoff(sinceDays: number, now: Date): string {
  return shiftDay(today(now), -(sinceDays - 1));
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
  if (opts.date) {
    files = files.filter((f) => f.startsWith(opts.date!));
  } else if (opts.sinceDays != null) {
    const from = cutoff(opts.sinceDays, now);
    files = files.filter((f) => f.slice(0, 10) >= from);
  }
  files.sort();

  const sidecars: unknown[] = [];
  let parseErrors = 0;
  for (const f of files) {
    try {
      const sidecar = JSON.parse(await readFile(path.join(logDir, f), "utf8")) as unknown;
      if (opts.includeSkimRequests && typeof sidecar === "object" && sidecar !== null) {
        (sidecar as { skimRequestText?: string }).skimRequestText = (await skimRequestText(logDir, f)) ?? undefined;
      }
      sidecars.push(sidecar);
    } catch {
      parseErrors += 1;
      sidecars.push({ __parseError: f });
    }
  }
  return { sidecars, files: files.length, parseErrors };
}
