import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { ingestRuleFires, parseFireLine, STORE_PATH } from '../src/db/ingest-rule-fires.js';
import { openDb } from '../src/db/open.js';

/**
 * `logs/rule-fires.jsonl` is MyCommand's append-only record of rule fires, and
 * `rule_fire` is a view of it. What matters: a re-run never counts a line twice,
 * a torn tail waits for its newline, and a null model is filled from the proxy's
 * own session row.
 */

/** One row as SQLite hands it back. */
type DbRow = Record<string, string | number | null>;

/** One line of `rule-fires.jsonl`, as MyCommand's `recordFire` writes it. */
interface FireFixture {
  v: number;
  rule: string;
  at: string;
  model: string | null;
  session: string;
  origin: string;
  suggestion?: string;
  bucket?: string;
  thread?: string;
}

const gateFire: FireFixture = {
  v: 1,
  rule: 'gate/sleep',
  at: '2026-10-06T12:00:00.000Z',
  model: 'claude-opus-5-5',
  session: 'sess-a',
  origin: 'hook',
};

const judgeFire: FireFixture = {
  v: 1,
  rule: 'prose/batched-discovery',
  at: '2026-10-06T12:05:00.000Z',
  model: null,
  session: 'sess-b',
  origin: 'judge',
  suggestion: 'serial-discovery',
  bucket: '3',
  thread: 'thread-b-child',
};

const line = (row: FireFixture): string => `${JSON.stringify(row)}\n`;

let logDir: string;
let store: string;
let db: DatabaseSync;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'rule-fires-'));
  store = path.join(logDir, STORE_PATH);
  db = openDb(logDir);
});

afterEach(async () => {
  db?.close();
  await rm(logDir, { recursive: true, force: true });
});

const rows = (): DbRow[] => {
  // SAFETY: every column `rule_fire` declares is TEXT or INTEGER — which is what `DbRow` says.
  return db.prepare('SELECT * FROM rule_fire ORDER BY byte_offset').all() as DbRow[];
};

/** A minimal `session` row: the NOT NULL columns plus the three the fill reads. */
function addSession(threadId: string, sessionId: string, model: string, parent: string | null = null): void {
  db.prepare(`
    INSERT INTO session (thread_id, model, session_id, started, tasks, decisions, tools, errors, bytes, modified, parent_thread_id)
    VALUES (?, ?, ?, '2026-10-06T11:00:00.000Z', 0, 0, 0, 0, 0, '2026-10-06T11:00:00.000Z', ?)
  `).run(threadId, model, sessionId, parent);
}

describe('parseFireLine', () => {
  it('maps the record to the table columns', () => {
    expect(parseFireLine(JSON.stringify(judgeFire))).toEqual({
      rule: 'prose/batched-discovery',
      at: '2026-10-06T12:05:00.000Z',
      model: null,
      sessionId: 'sess-b',
      origin: 'judge',
      suggestion: 'serial-discovery',
      bucket: '3',
      threadId: 'thread-b-child',
    });
  });

  it('reads an empty session as null and a missing origin as a hook', () => {
    expect(parseFireLine(JSON.stringify({ rule: 'gate/cd', at: 'x', session: '' }))).toMatchObject({
      sessionId: null,
      origin: 'hook',
    });
  });

  it('refuses a line it cannot store', () => {
    expect(parseFireLine('{"rule":"gate/cd"')).toBeNull();
    expect(parseFireLine(JSON.stringify({ rule: 'gate/cd' }))).toBeNull();
    expect(parseFireLine(JSON.stringify({ ...gateFire, v: 2 }))).toBeNull();
  });
});

describe('ingestRuleFires', () => {
  it('reports zero rather than failing when the file is not there', async () => {
    expect(await ingestRuleFires(db, logDir)).toEqual({ fires: 0, parsed: 0, skipped: 0, filled: 0, deleted: 0 });
  });

  it('stores every column the contract names', async () => {
    await writeFile(store, line(gateFire) + line(judgeFire));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 2, parsed: 2, skipped: 0 });
    expect(rows()).toEqual([
      {
        byte_offset: 0,
        rule: 'gate/sleep',
        at: gateFire.at,
        model: 'claude-opus-5-5',
        session_id: 'sess-a',
        origin: 'hook',
        suggestion: null,
        bucket: null,
        thread_id: null,
      },
      {
        byte_offset: Buffer.byteLength(line(gateFire)),
        rule: 'prose/batched-discovery',
        at: judgeFire.at,
        model: null,
        session_id: 'sess-b',
        origin: 'judge',
        suggestion: 'serial-discovery',
        bucket: '3',
        thread_id: 'thread-b-child',
      },
    ]);
  });

  it('resumes from its byte watermark, so a re-run never double-counts', async () => {
    await writeFile(store, line(gateFire));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 1, parsed: 1 });
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 1, parsed: 0 });

    // The same fire twice is two fires: identity is the line's position, not its content.
    await appendFile(store, line(gateFire));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 2, parsed: 1 });
  });

  it('re-reading consumed bytes after a watermark clear upserts instead of adding', async () => {
    await writeFile(store, line(gateFire) + line(judgeFire));
    await ingestRuleFires(db, logDir);
    db.prepare('DELETE FROM file_watermark WHERE path = ?').run(STORE_PATH);

    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 2, parsed: 2 });
  });

  it('leaves a torn final line for the pass after its newline lands', async () => {
    const torn = JSON.stringify(judgeFire);
    await writeFile(store, line(gateFire) + torn.slice(0, 20));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 1, parsed: 1, skipped: 0 });

    await appendFile(store, `${torn.slice(20)}\n`);
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 2, parsed: 1, skipped: 0 });
    expect(rows()[1]).toMatchObject({ rule: 'prose/batched-discovery' });
  });

  it('counts a malformed complete line as skipped and moves past it', async () => {
    await writeFile(store, `not json\n${line({ ...gateFire, v: 9 })}${line(gateFire)}`);
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 1, parsed: 1, skipped: 2 });
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ parsed: 0, skipped: 0 });
  });

  it('rebuilds from offset 0 when the file is shorter than its watermark', async () => {
    await writeFile(store, line(gateFire) + line(judgeFire));
    await ingestRuleFires(db, logDir);

    await writeFile(store, line(judgeFire));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 1, parsed: 1, deleted: 2 });
    expect(rows()[0]).toMatchObject({ byte_offset: 0, rule: 'prose/batched-discovery' });
  });

  it('drops the rows when the file is removed', async () => {
    await writeFile(store, line(gateFire));
    await ingestRuleFires(db, logDir);
    await rm(store);

    expect(await ingestRuleFires(db, logDir)).toMatchObject({ fires: 0, deleted: 1 });
  });
});

describe('filling a null model from the session table', () => {
  it('prefers the thread the fire names, since a subagent can run another model', async () => {
    addSession('thread-b-root', 'sess-b', 'claude-opus-5-5');
    addSession('thread-b-child', 'sess-b', 'claude-haiku-4-5-20251001', 'thread-b-root');
    await writeFile(store, line(judgeFire));

    expect(await ingestRuleFires(db, logDir)).toMatchObject({ filled: 1 });
    expect(rows()[0]?.model).toBe('claude-haiku-4-5-20251001');
  });

  it("falls back to the session's root row by session_id", async () => {
    addSession('thread-c-child', 'sess-c', 'claude-haiku-4-5-20251001', 'thread-c-root');
    addSession('thread-c-root', 'sess-c', 'claude-sonnet-5-5');
    await writeFile(store, line({ ...gateFire, model: null, session: 'sess-c' }));

    await ingestRuleFires(db, logDir);
    expect(rows()[0]?.model).toBe('claude-sonnet-5-5');
  });

  it('never overwrites a model the fire recorded', async () => {
    addSession('thread-a', 'sess-a', 'claude-sonnet-5-5');
    await writeFile(store, line(gateFire));

    expect(await ingestRuleFires(db, logDir)).toMatchObject({ filled: 0 });
    expect(rows()[0]?.model).toBe('claude-opus-5-5');
  });

  it('fills on a later pass once the session row arrives', async () => {
    await writeFile(store, line({ ...gateFire, model: null, session: 'sess-d' }));
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ filled: 0 });
    expect(rows()[0]?.model).toBeNull();

    addSession('thread-d', 'sess-d', 'claude-opus-5-5');
    expect(await ingestRuleFires(db, logDir)).toMatchObject({ parsed: 0, filled: 1 });
    expect(rows()[0]?.model).toBe('claude-opus-5-5');
  });

  it('runs as part of the full ingest pass', async () => {
    await writeFile(store, line(gateFire));
    expect(await ingest(db, logDir)).toMatchObject({ ruleFires: 1, ruleFiresParsed: 1 });
  });
});
