import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  parseRecordedSpawn,
  parseSessionNodeHashes,
  parseSessionNodes,
  parseSessionNodeTexts,
  parseSessionTranscript,
} from '@claude-proxy/core';
import { parseJson, stringField } from '../json.js';
import { resolveSessionsDir, SESSION_FILE_RE } from '../sessions.js';

/**
 * Index `logs/sessions/` into the `session`, `session_node` and
 * `session_node_text` tables.
 *
 * Transcripts are mutable — the proxy appends for the life of a run — so the
 * watermark is per file rather than per directory: a row keeps the `bytes` and
 * `modified` it was parsed from, and a file whose `stat` still matches is
 * skipped.
 */

/** `<threadId>.md` relative to `logDir` — the pointer stored on the row. */
function mdPath(threadId: string): string {
  return `sessions/${threadId}.md`;
}

/**
 * True when a failed `readdir` says the directory simply is not there. Anything else
 * the filesystem raised — a permission error, a broken mount — says nothing about
 * whether `sessions/` exists, so the caller must rethrow it rather than drop its rows.
 */
function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
}

export interface SessionIngestStats {
  /** Transcripts on disk this pass. */
  seen: number;
  /** Transcripts parsed — new, or changed since their row was written. */
  parsed: number;
  /** Rows dropped because their transcript is no longer on disk. */
  deleted: number;
}

interface SessionStatements {
  insertSession: ReturnType<DatabaseSync['prepare']>;
  insertNode: ReturnType<DatabaseSync['prepare']>;
  insertNodeText: ReturnType<DatabaseSync['prepare']>;
  clearNodes: ReturnType<DatabaseSync['prepare']>;
  clearNodeTexts: ReturnType<DatabaseSync['prepare']>;
  deleteSession: ReturnType<DatabaseSync['prepare']>;
}

function prepare(db: DatabaseSync): SessionStatements {
  return {
    // Upsert rather than insert-once: a transcript is re-parsed on every append.
    insertSession: db.prepare(`
      INSERT INTO session (
        thread_id, model, session_id, started,
        tasks, decisions, tools, errors,
        first_task, title, subtitle, derived_title,
        bytes, modified, md_path, root_prompt,
        parent_thread_id, spawn_index, spawn_agent_type, pr_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        model = excluded.model, session_id = excluded.session_id, started = excluded.started,
        tasks = excluded.tasks, decisions = excluded.decisions, tools = excluded.tools,
        errors = excluded.errors, first_task = excluded.first_task, title = excluded.title,
        subtitle = excluded.subtitle, derived_title = excluded.derived_title,
        bytes = excluded.bytes, modified = excluded.modified, md_path = excluded.md_path,
        root_prompt = excluded.root_prompt, parent_thread_id = excluded.parent_thread_id,
        spawn_index = excluded.spawn_index, spawn_agent_type = excluded.spawn_agent_type,
        pr_url = excluded.pr_url
    `),
    insertNode: db.prepare(`
      INSERT INTO session_node (thread_id, idx, type, text, tool, task, interruption, interrupted, message, turn, args_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // A `.nodes.jsonl` naming the same index twice: last entry wins, matching
    // the file reader's plain-object assignment.
    insertNodeText: db.prepare(`
      INSERT INTO session_node_text (thread_id, idx, text) VALUES (?, ?, ?)
      ON CONFLICT(thread_id, idx) DO UPDATE SET text = excluded.text
    `),
    clearNodes: db.prepare('DELETE FROM session_node WHERE thread_id = ?'),
    clearNodeTexts: db.prepare('DELETE FROM session_node_text WHERE thread_id = ?'),
    deleteSession: db.prepare('DELETE FROM session WHERE thread_id = ?'),
  };
}

/** What one transcript and its sidecars parse to, ready to write. */
interface ParsedSession {
  threadId: string;
  content: string;
  bytes: number;
  modified: string;
  rootPrompt: string | null;
  /** The pull request the run recorded having opened, off the same sidecar. */
  prUrl: string | null;
  nodeTexts: Record<number, string>;
  /** Per-node argument fingerprints off the same sidecar — see `SessionNode.argsHash`. */
  nodeHashes: Record<number, string>;
}

/**
 * The two facts the `.state.json` sidecar records about a thread: its untruncated opening
 * prompt (mirroring `readRootPrompt` in `command-runs.ts`) and the pull request it opened.
 * One read for both — a thread that has either has the same file to open.
 */
async function readSidecarFacts(dir: string, threadId: string): Promise<{ root: string | null; pr: string | null }> {
  try {
    const state = parseJson(await readFile(path.join(dir, `${threadId}.state.json`), 'utf8'));
    // A recorded-but-empty `pr` is no pull request: the sidecar writes the field
    // before the run has one to name.
    const pr = stringField(state, 'pr');
    return {
      root: stringField(state, 'root') ?? null,
      pr: pr === undefined || pr === '' ? null : pr,
    };
  } catch {
    return { root: null, pr: null }; // no sidecar, or it went away
  }
}

/**
 * The `.nodes.jsonl` sidecar's two sparse maps — untruncated texts and argument
 * fingerprints — or empty ones when it is absent. Read in one pass: the rows carry
 * both, and a row can carry either alone.
 */
async function readNodeSidecar(
  dir: string,
  threadId: string,
): Promise<{ texts: Record<number, string>; hashes: Record<number, string> }> {
  try {
    const content = await readFile(path.join(dir, `${threadId}.nodes.jsonl`), 'utf8');
    return { texts: parseSessionNodeTexts(content), hashes: parseSessionNodeHashes(content) };
  } catch {
    return { texts: {}, hashes: {} };
  }
}

/** Read one transcript plus its two sidecars, or null if it vanished mid-pass. */
async function readSessionFiles(dir: string, threadId: string): Promise<ParsedSession | null> {
  let content: string;
  let bytes: number;
  let modified: string;
  try {
    const [text, info] = await Promise.all([
      readFile(path.join(dir, `${threadId}.md`), 'utf8'),
      stat(path.join(dir, `${threadId}.md`)),
    ]);
    content = text;
    bytes = info.size;
    modified = info.mtime.toISOString();
  } catch {
    return null;
  }
  const [facts, sidecar] = await Promise.all([readSidecarFacts(dir, threadId), readNodeSidecar(dir, threadId)]);
  return {
    threadId,
    content,
    bytes,
    modified,
    rootPrompt: facts.root,
    prUrl: facts.pr,
    nodeTexts: sidecar.texts,
    nodeHashes: sidecar.hashes,
  };
}

/** Write one transcript's row and its node stream, replacing whatever was there. */
function writeSession(st: SessionStatements, parsed: ParsedSession): void {
  const meta = parseSessionTranscript(parsed.threadId, parsed.content);
  const recorded = parseRecordedSpawn(parsed.content);
  st.insertSession.run(
    meta.threadId,
    meta.model,
    meta.sessionId,
    meta.started,
    meta.tasks,
    meta.decisions,
    meta.tools,
    meta.errors,
    meta.firstTask,
    meta.title,
    meta.subtitle,
    meta.derivedTitle,
    parsed.bytes,
    parsed.modified,
    mdPath(parsed.threadId),
    parsed.rootPrompt,
    recorded?.parentThreadId ?? null,
    recorded?.spawnIndex ?? null,
    recorded?.agentType ?? null,
    parsed.prUrl,
  );

  // Delete then insert: a transcript can be rewritten, not only extended.
  st.clearNodes.run(parsed.threadId);
  for (const node of parseSessionNodes(parsed.content, parsed.nodeHashes)) {
    st.insertNode.run(
      parsed.threadId,
      node.index,
      node.type,
      node.text,
      node.tool,
      node.task,
      node.interruption,
      node.interrupted ? 1 : 0,
      node.message,
      node.turn,
      node.argsHash,
    );
  }

  st.clearNodeTexts.run(parsed.threadId);
  for (const [idx, text] of Object.entries(parsed.nodeTexts)) {
    st.insertNodeText.run(parsed.threadId, Number(idx), text);
  }
}

/** How many transcripts to read before writing a batch. */
const BATCH = 100;

/**
 * Bring the session tables level with `logs/sessions/`. Safe to call repeatedly:
 * an unchanged transcript is not re-read, and a part-way failure leaves the
 * committed batches for the next pass to resume from.
 */
export async function ingestSessions(db: DatabaseSync, logDir: string): Promise<SessionIngestStats> {
  const stats: SessionIngestStats = { seen: 0, parsed: 0, deleted: 0 };
  const dir = resolveSessionsDir(logDir);

  let names: string[];
  try {
    names = await readdir(dir);
  } catch (cause) {
    // Only a *missing* `sessions/` means the rows are unbacked. Any other error
    // says nothing about what is on disk, so it must not drop the tables.
    if (!isMissingFile(cause)) throw cause;
    const st = prepare(db);
    db.exec('BEGIN');
    try {
      // SAFETY: this SELECT names exactly `thread_id`, which is what the row type declares.
      for (const row of db.prepare('SELECT thread_id FROM session').all() as Array<{ thread_id: string }>) {
        st.deleteSession.run(row.thread_id);
        stats.deleted += 1;
      }
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }
    return stats;
  }

  const threadIds = names
    .filter((n) => SESSION_FILE_RE.test(n))
    .map((n) => n.slice(0, -'.md'.length))
    .sort();
  stats.seen = threadIds.length;

  const st = prepare(db);

  // Rows whose transcript left the directory. `ON DELETE CASCADE` takes the node
  // stream and node texts with them.
  const present = new Set(threadIds);
  db.exec('BEGIN');
  try {
    // SAFETY: this SELECT names exactly `thread_id`, which is what the row type declares.
    for (const row of db.prepare('SELECT thread_id FROM session').all() as Array<{ thread_id: string }>) {
      if (present.has(row.thread_id)) continue;
      st.deleteSession.run(row.thread_id);
      stats.deleted += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const known = new Map<string, { bytes: number; modified: string }>();
  // SAFETY: this SELECT names exactly `thread_id`, `bytes` and `modified`, which is
  // what the row type declares.
  for (const row of db.prepare('SELECT thread_id, bytes, modified FROM session').all() as Array<{
    thread_id: string;
    bytes: number;
    modified: string;
  }>) {
    known.set(row.thread_id, { bytes: row.bytes, modified: row.modified });
  }

  // The per-file watermark: one `stat` per transcript in place of a re-parse.
  const stale: string[] = [];
  for (const threadId of threadIds) {
    const mark = known.get(threadId);
    if (!mark) {
      stale.push(threadId);
      continue;
    }
    try {
      const info = await stat(path.join(dir, `${threadId}.md`));
      if (info.size !== mark.bytes || info.mtime.toISOString() !== mark.modified) stale.push(threadId);
    } catch {
      // Vanished between the listing and the stat; the next pass reconciles it.
    }
  }

  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = (await Promise.all(stale.slice(i, i + BATCH).map((id) => readSessionFiles(dir, id)))).filter(
      (p): p is ParsedSession => p !== null,
    );
    db.exec('BEGIN');
    try {
      for (const parsed of batch) {
        writeSession(st, parsed);
        stats.parsed += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return stats;
}
