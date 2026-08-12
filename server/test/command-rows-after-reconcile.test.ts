/**
 * `/api/commands` reconciles the command store and then reads it back inside the
 * same request. That append moves the store's size *and* its mtime, so the
 * watermark equality in `dbSource.readCommandRuns` could never hold on this route
 * and every request re-parsed the whole store — 48 MB of it on this device, with
 * the six command tables bypassed on the one route they were built to serve.
 *
 * The reconcile now reports what it appended, and the substrate folds those records
 * into the tables and moves the watermark with them. These tests hold both halves
 * down: the rows must answer *without* opening the file, and they must be exactly
 * the rows a whole-store parse would have written.
 */

import crypto from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandStorePath, reconcileCommandRuns, type StoreAppend } from '../src/command-runs.js';
import { applyCommandRunAppend, ingestCommandRuns, STORE_PATH } from '../src/db/ingest-commands.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource } from '../src/db/source.js';

const COMMAND_FILE = `---
description: Ship a task.
---

## Step 1 — Set up the workspace

Run \`my-command-tools worktree begin\` first.

## Step 2 — Implement

Verify with \`my-command-tools verify\`.
`;

const NOW = new Date('2026-07-15T18:00:00.000Z');

let logDir: string;
let commandsDir: string;
let db: DatabaseSync;

function envelope(command: string, args: string): string {
  return `<command-message>${command}</command-message>\n<command-name>/${command}</command-name>\n<command-args>${args}</command-args>`;
}

/** The thread id the proxy would have derived, so transcript and body agree. */
function threadIdFor(sessionId: string, root: string): string {
  return crypto.createHash('sha256').update(`${sessionId}\n${root}`).digest('hex').slice(0, 16);
}

async function writeSession(sessionId: string, root: string, body: string, started: string): Promise<string> {
  const threadId = threadIdFor(sessionId, root);
  const dir = path.join(logDir, 'sessions');
  await writeFile(
    path.join(dir, `${threadId}.md`),
    `# Session ${threadId}\n- model: claude-opus-5\n- session: ${sessionId}\n- started: ${started}\n\n\n## Task: ${root.slice(0, 60)}\n${body}\n`,
    'utf8',
  );
  await writeFile(path.join(dir, `${threadId}.state.json`), JSON.stringify({ count: 1, started, root }), 'utf8');
  return threadId;
}

/** The store's `stat`, as the watermark records it. */
async function markOf(): Promise<{ bytes: number; modified: string }> {
  const info = await stat(commandStorePath(logDir));
  return { bytes: info.size, modified: info.mtime.toISOString() };
}

/** The watermark row the substrate keeps for the store. */
function watermark(): { bytes: number; modified: string } | undefined {
  return db.prepare('SELECT bytes, modified FROM file_watermark WHERE path = ?').get(STORE_PATH) as
    | { bytes: number; modified: string }
    | undefined;
}

/** Every command row, keyed and positioned — what a parse of the store produces. */
function rows(): unknown[] {
  return db.prepare('SELECT run_id, ord, command, ended, document FROM command_run ORDER BY ord').all();
}

/** The reconcile, plus the fold the server does with its result. */
async function reconcileAndSync(): Promise<{ append: StoreAppend | null; folded: boolean }> {
  const result = await reconcileCommandRuns(logDir, commandsDir, NOW);
  const append = result.appended;
  return { append, folded: append ? applyCommandRunAppend(db, append) : false };
}

const SESSION_A = '11111111-2222-3333-4444-555555555555';
const SESSION_B = '99999999-8888-7777-6666-555555555555';
const ROOT_A = `${envelope('task', 'add a commands page')}\n\nadd a commands page`;
const ROOT_B = `${envelope('task', 'read the rows back')}\n\nread the rows back`;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'command-rows-'));
  commandsDir = await mkdtemp(path.join(tmpdir(), 'commands-'));
  await mkdir(path.join(logDir, 'sessions'), { recursive: true });
  await writeFile(path.join(commandsDir, 'task.md'), COMMAND_FILE, 'utf8');

  // One run on record, indexed and level: the state every request starts from
  // once the ingest watcher has caught up.
  await writeSession(SESSION_A, ROOT_A, '- decided: starting', '2026-07-15T14:00:00.000Z');
  await reconcileCommandRuns(logDir, commandsDir, NOW);
  db = openDb(logDir);
  await ingestCommandRuns(db, logDir);
  expect(watermark()).toEqual(await markOf());
});

afterEach(async () => {
  db?.close();
  await rm(logDir, { recursive: true, force: true });
  await rm(commandsDir, { recursive: true, force: true });
});

describe('the reconcile hands its appends to the command tables', () => {
  it('leaves the watermark level with the store, so the read that follows queries rows', async () => {
    // The run grows, which is what makes the pass rewrite its record — and what
    // used to make the watermark unsatisfiable for the rest of the request.
    await writeSession(
      SESSION_A,
      ROOT_A,
      '- decided: starting\n- Bash(command=my-command-tools verify)',
      '2026-07-15T14:00:00.000Z',
    );

    const { append, folded } = await reconcileAndSync();
    expect(append?.records).toHaveLength(1);
    expect(folded).toBe(true);

    // The equality `readCommandRuns` gates the query path on now holds, on the
    // very route that did the appending.
    expect(watermark()).toEqual(await markOf());
    expect(await dbSource(db).readCommandRuns(logDir)).toEqual(await fileSource.readCommandRuns(logDir));
  });

  it('answers from the rows without opening the store at all', async () => {
    await writeSession(
      SESSION_A,
      ROOT_A,
      '- decided: starting\n- Bash(command=my-command-tools verify)\n- done: ok',
      '2026-07-15T14:00:00.000Z',
    );
    const { folded } = await reconcileAndSync();
    expect(folded).toBe(true);
    const expected = await fileSource.readCommandRuns(logDir);
    expect(expected).toHaveLength(1);

    // Overwrite the store's *contents* with unparseable bytes of the same length,
    // then put its mtime back. Nothing the watermark can see has changed, so a
    // reader that opens the file finds no runs and one that queries rows finds
    // them all — which is the difference this asserts.
    const file = commandStorePath(logDir);
    const before = await markOf();
    const disguised = 'x'.repeat((await readFile(file, 'utf8')).length);
    await writeFile(file, disguised, 'utf8');
    await utimes(file, new Date(before.modified), new Date(before.modified));
    expect(await markOf(), 'the disguise has to be invisible to the watermark').toEqual(before);

    expect(await fileSource.readCommandRuns(logDir), 'the file reader sees nothing to parse').toEqual([]);
    expect(await dbSource(db).readCommandRuns(logDir)).toEqual(expected);
  });

  it('writes exactly the rows a whole-store parse writes, positions included', async () => {
    // A record superseded in place, and a run the store has never held — the two
    // cases `ord` has to get right, since a new key lands at the tail while an
    // existing one keeps the position it first appeared at.
    await writeSession(
      SESSION_A,
      ROOT_A,
      '- decided: starting\n- Bash(command=my-command-tools verify)',
      '2026-07-15T14:00:00.000Z',
    );
    await writeSession(SESSION_B, ROOT_B, '- done: ok', '2026-07-15T15:00:00.000Z');

    const { append, folded } = await reconcileAndSync();
    expect(append?.records).toHaveLength(2);
    expect(folded).toBe(true);
    const folded_rows = rows();
    expect(folded_rows).toHaveLength(2);

    // Now make the substrate parse the store from scratch and compare. The fold
    // is only correct if it is indistinguishable from the rebuild.
    db.prepare('DELETE FROM file_watermark WHERE path = ?').run(STORE_PATH);
    const stats = await ingestCommandRuns(db, logDir);
    expect(stats.parsed).toBe(true);
    expect(rows()).toEqual(folded_rows);
    expect(watermark()).toEqual(await markOf());
  });

  it('reports nothing to fold when the pass appended nothing', async () => {
    // Idempotent second pass: the store did not move, so the watermark still
    // matches and the rows were already answering.
    const { append, folded } = await reconcileAndSync();
    expect(append).toBeNull();
    expect(folded).toBe(false);
    expect(watermark()).toEqual(await markOf());
  });
});

describe('the watermark still guards an append the server did not make', () => {
  it('refuses to fold into rows that do not sit where the append started', async () => {
    // Something else appended after the substrate last looked — the case the
    // watermark check was written for. The pass's records extend a prefix the
    // rows do not cover, so there is nothing correct to add them to.
    const outsider = (await fileSource.readCommandRuns(logDir))[0];
    expect(outsider).toBeDefined();
    const append: StoreAppend = {
      records: [{ ...outsider!, ended: '2026-07-16T00:00:00.000Z' }],
      before: { bytes: 1, modified: '1999-01-01T00:00:00.000Z' },
      after: await markOf(),
    };

    const mark = watermark();
    expect(applyCommandRunAppend(db, append)).toBe(false);
    expect(watermark(), 'a refused fold must not move the watermark').toEqual(mark);
  });

  it('falls back to the file when a third party appends between the fold and the read', async () => {
    await writeSession(
      SESSION_A,
      ROOT_A,
      '- decided: starting\n- Bash(command=my-command-tools verify)',
      '2026-07-15T14:00:00.000Z',
    );
    expect((await reconcileAndSync()).folded).toBe(true);

    // An append from outside this process. The watermark no longer matches, so
    // the read goes back to the file — stale rows are never served.
    await writeSession(SESSION_B, ROOT_B, '- done: ok', '2026-07-15T15:00:00.000Z');
    await reconcileCommandRuns(logDir, commandsDir, NOW);

    const fromFile = await fileSource.readCommandRuns(logDir);
    expect(fromFile).toHaveLength(2);
    expect(await dbSource(db).readCommandRuns(logDir)).toEqual(fromFile);
    expect((db.prepare('SELECT count(*) c FROM command_run').get() as { c: number }).c).toBe(1);
  });
});
