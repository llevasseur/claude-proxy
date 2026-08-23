import crypto from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  firstUserText,
  linkAgentSessions,
  parseRecordedSpawn,
  parseSessionNodeHashes,
  parseSessionNodes,
  parseSessionNodeTexts,
  parseSessionTranscript,
  type SessionAgentLink,
  type SessionMeta,
  type SessionNode,
} from '@agent-proxy/claude-core';
import { parseJson, stringField } from './json.js';

/**
 * The thread id a captured request belongs to: a hash of its session id and its conversation
 * root. Mirrors `threadIdFor` in `proxy/session.ts`, which named the transcript in the first
 * place. Null when the body has no user text to root on.
 */
// `messages` stays `unknown` because `firstUserText` in `@agent-proxy/claude-core` is the
// decoder for it and its own parameter is `unknown`; nothing here reads the array.
// Narrowing it to `JsonInput` is a change to a shared signature that
// `server/test/session-graph-nodes` hands an `unknown[]`.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- see the note above.
export function threadIdForBody(sessionId: string | null, messages: unknown): string | null {
  const root = firstUserText(messages);
  if (!root) return null;
  return crypto
    .createHash('sha256')
    .update(`${sessionId ?? ''}\n${root}`)
    .digest('hex')
    .slice(0, 16);
}

/** Session transcripts live in `<LOG_DIR>/sessions/`, written by the proxy. */
export function resolveSessionsDir(logDir: string): string {
  return path.join(logDir, 'sessions');
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
      const [content, info] = await Promise.all([readFile(path.join(dir, name), 'utf8'), stat(path.join(dir, name))]);
      const meta = parseSessionTranscript(name.replace(/\.md$/, ''), content);
      return { ...meta, bytes: info.size, modified: info.mtime.toISOString() };
    }),
  );

  rows.sort((a, b) => b.modified.localeCompare(a.modified) || a.threadId.localeCompare(b.threadId));
  return rows;
}

/**
 * The untruncated opening prompts of the named threads, off their `.state.json`
 * sidecars — the same `root` field `command-runs.ts` reads, and the same one the
 * substrate ingests into `session.root_prompt`.
 *
 * Only the ids asked for are opened — reading the whole directory is megabytes of
 * prompt to answer a question about a handful of threads. A thread with no
 * sidecar, a torn one, or one recorded before the proxy had a prompt to record is
 * absent from the result; the transcript's own `subtitle` is capped at 200
 * characters and so is not a substitute.
 */
export async function readRootPrompts(logDir: string, threadIds: readonly string[]): Promise<Map<string, string>> {
  const dir = resolveSessionsDir(logDir);
  const wanted = [...new Set(threadIds)].filter((id) => THREAD_ID_RE.test(id)).sort();

  const out = new Map<string, string>();
  await Promise.all(
    wanted.map(async (threadId) => {
      try {
        const raw = await readFile(path.join(dir, `${threadId}.state.json`), 'utf8');
        const root = stringField(parseJson(raw), 'root');
        if (root) out.set(threadId, root);
      } catch {
        // no sidecar, or it went away — the thread just has no prompt on record
      }
    }),
  );
  return out;
}

/** A `.state.json` sidecar's own name, the one file per thread that records these facts. */
const STATE_FILE_RE = /^([0-9a-f]{16})\.state\.json$/;

/**
 * Every thread that recorded a pull request it opened, thread id → url — the same `pr`
 * field the substrate ingests into `session.pr_url`, read off the sidecars directly.
 *
 * Read wholesale rather than by id, because the question this answers is the reverse one:
 * which threads name *this* pull request. That is a directory of small JSON sidecars, not
 * the megabytes of transcript `server/src/pr-sessions.ts` reads when nothing recorded a
 * link. A thread with no sidecar, a torn one, or one written before the proxy recorded the
 * field is simply absent.
 */
export async function readPrLinks(logDir: string): Promise<Map<string, string>> {
  const dir = resolveSessionsDir(logDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return new Map(); // no `sessions/` yet
  }

  const out = new Map<string, string>();
  await Promise.all(
    names.map(async (name) => {
      const threadId = STATE_FILE_RE.exec(name)?.[1];
      if (!threadId) return;
      try {
        const pr = stringField(parseJson(await readFile(path.join(dir, name), 'utf8')), 'pr');
        if (pr) out.set(threadId, pr);
      } catch {
        // unreadable or torn sidecar — the thread just has no link on record
      }
    }),
  );
  return out;
}

/**
 * The per-node argument fingerprints off a transcript's `.nodes.jsonl`, or none when
 * the sidecar is absent or predates the field.
 */
async function readNodeHashes(dir: string, threadId: string): Promise<Record<number, string>> {
  try {
    return parseSessionNodeHashes(await readFile(path.join(dir, `${threadId}.nodes.jsonl`), 'utf8'));
  } catch {
    return {};
  }
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
      const threadId = name.replace(/\.md$/, '');
      const [content, info] = await Promise.all([readFile(path.join(dir, name), 'utf8'), stat(path.join(dir, name))]);
      const meta = parseSessionTranscript(threadId, content);
      return {
        ...meta,
        bytes: info.size,
        modified: info.mtime.toISOString(),
        nodes: parseSessionNodes(content, await readNodeHashes(dir, threadId)),
        recorded: parseRecordedSpawn(content),
      };
    }),
  );

  const links = linkAgentSessions(rows);
  // `recorded` is an input to the linkage, not part of the listing's wire shape.
  const linked = rows.map(({ recorded: _recorded, ...row }) => ({ ...row, ...links.get(row.threadId)! }));

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
    return { threadId: id, texts: parseSessionNodeTexts(await readFile(full, 'utf8')) };
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
  let info: import('node:fs').Stats;
  try {
    [content, info] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
  } catch {
    throw new Error(`session not found: ${id}`);
  }

  return { meta: parseSessionTranscript(id, content), content, bytes: info.size, modified: info.mtime.toISOString() };
}
