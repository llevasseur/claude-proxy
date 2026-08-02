import crypto from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  firstUserText,
  linkAgentSessions,
  parseSessionNodes,
  parseSessionNodeTexts,
  parseSessionTranscript,
  type SessionAgentLink,
  type SessionMeta,
  type SessionNode,
} from "@claude-proxy/core";

/**
 * The thread id a captured request belongs to: a hash of its session id and its conversation
 * root. Mirrors `threadIdFor` in `proxy/session.mjs`, which named the transcript in the first
 * place. Null when the body has no user text to root on.
 */
export function threadIdForBody(sessionId: string | null, messages: unknown): string | null {
  const root = firstUserText(messages);
  if (!root) return null;
  return crypto
    .createHash("sha256")
    .update(`${sessionId ?? ""}\n${root}`)
    .digest("hex")
    .slice(0, 16);
}

/** Session transcripts live in `<LOG_DIR>/sessions/`, written by the proxy. */
export function resolveSessionsDir(logDir: string): string {
  return path.join(logDir, "sessions");
}

/** A thread id is a 16-hex-char stem; the transcript is `<id>.md`. The name comes
 * from the URL, so traversal must be impossible — reject anything else. Exported
 * so the substrate's ingest picks exactly the files this module's listings do. */
export const SESSION_FILE_RE = /^[0-9a-f]{16}\.md$/;
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

/** One transcript's listing row, its ordered stream of appended nodes, and its place in the agent tree. */
export interface SessionGraph extends SessionSummary, SessionAgentLink {
  nodes: SessionNode[];
}

/**
 * List every session transcript with its structured node stream, newest first.
 * Like {@link listSessions} but also parses each transcript's appended lines
 * (task/decision/tool/error/done) and reconstructs which transcripts are subagents
 * of which, so the graph can render a session's branches without shipping — or
 * re-parsing — raw Markdown in the browser. Empty when no `sessions/` dir.
 */
export async function listSessionGraphs(logDir: string): Promise<SessionGraph[]> {
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
      return {
        ...meta,
        bytes: info.size,
        modified: info.mtime.toISOString(),
        nodes: parseSessionNodes(content),
      };
    }),
  );

  const links = linkAgentSessions(rows);
  const linked = rows.map((row) => ({ ...row, ...links.get(row.threadId)! }));

  linked.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  return linked;
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

/** A transcript's untruncated node texts, keyed by node index. */
export interface SessionNodeTexts {
  threadId: string;
  texts: Record<number, string>;
}

/**
 * Read the untruncated text behind a transcript's truncated node lines. Validates
 * the (URL-supplied) thread id the same way {@link resolveSessionFile} does. A
 * transcript with no sidecar — captured before the proxy wrote one, or nothing
 * needed truncating — reads as empty rather than 404.
 */
export async function readSessionNodeTexts(logDir: string, id: string): Promise<SessionNodeTexts> {
  if (!THREAD_ID_RE.test(id)) {
    throw new Error(`invalid session id: ${id}`);
  }
  const dir = resolveSessionsDir(logDir);
  const full = path.resolve(dir, `${id}.nodes.jsonl`);
  if (path.dirname(full) !== path.resolve(dir)) {
    throw new Error(`invalid session id: ${id}`);
  }

  try {
    return { threadId: id, texts: parseSessionNodeTexts(await readFile(full, "utf8")) };
  } catch {
    return { threadId: id, texts: {} };
  }
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
