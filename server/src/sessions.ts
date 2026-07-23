import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseSessionTranscript, type SessionMeta } from "@claude-proxy/core";

/** Session transcripts live in `<LOG_DIR>/sessions/`, written by the proxy. */
export function resolveSessionsDir(logDir: string): string {
  return path.join(logDir, "sessions");
}

/** A thread id is a 16-hex-char stem; the transcript is `<id>.md`. The name comes
 * from the URL, so traversal must be impossible — reject anything else. */
const SESSION_FILE_RE = /^[0-9a-f]{16}\.md$/;
const THREAD_ID_RE = /^[0-9a-f]{16}$/;

/** One transcript's listing row: parsed metadata plus size and mtime. */
export interface SessionSummary extends SessionMeta {
  bytes: number;
  /** Last-modified time, ISO 8601 (UTC). */
  modified: string;
}

/** One transcript's full contents plus its parsed metadata. */
export interface SessionDetail {
  meta: SessionMeta;
  content: string;
  bytes: number;
  modified: string;
}

/**
 * List every session transcript, newest first (by mtime). Returns an empty list
 * when the `sessions/` dir doesn't exist yet (the proxy hasn't written one).
 * The `.state.json` sidecars and any non-transcript files are ignored.
 */
export async function listSessions(logDir: string): Promise<SessionSummary[]> {
  const dir = resolveSessionsDir(logDir);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return []; // no sessions yet — not an error
  }

  const files = names.filter((f) => SESSION_FILE_RE.test(f));
  const rows = await Promise.all(
    files.map(async (name) => {
      const [content, info] = await Promise.all([readFile(path.join(dir, name), "utf8"), stat(path.join(dir, name))]);
      const meta = parseSessionTranscript(name.replace(/\.md$/, ""), content);
      return { ...meta, bytes: info.size, modified: info.mtime.toISOString() };
    }),
  );

  rows.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  return rows;
}

/**
 * Validate a (URL-supplied) thread id and resolve its transcript path, confirming
 * the result stays inside the `sessions/` dir so traversal is impossible. Throws a
 * labelled `invalid session id` error the server maps to 400. Shared by
 * {@link readSession} and the live SSE watcher.
 */
export function resolveSessionFile(logDir: string, id: string): string {
  if (!THREAD_ID_RE.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
  const dir = resolveSessionsDir(logDir);
  const full = path.resolve(dir, `${id}.md`);
  if (path.dirname(full) !== path.resolve(dir)) {
    throw new Error(`invalid session id: ${id}`);
  }
  return full;
}

/**
 * Read one transcript's full contents plus parsed metadata. Validates the
 * (URL-supplied) thread id and confirms the resolved path stays inside the
 * `sessions/` dir before touching disk. Throws a labelled error the server maps
 * to 400 (bad id) / 404 (missing file).
 */
export async function readSession(logDir: string, id: string): Promise<SessionDetail> {
  const full = resolveSessionFile(logDir, id);

  let content: string;
  let info: import("node:fs").Stats;
  try {
    [content, info] = await Promise.all([readFile(full, "utf8"), stat(full)]);
  } catch {
    throw new Error(`session not found: ${id}`);
  }

  return { meta: parseSessionTranscript(id, content), content, bytes: info.size, modified: info.mtime.toISOString() };
}
