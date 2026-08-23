import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { openDb, SCHEMA_VERSION } from '../src/db/open.js';
import { dbSource } from '../src/db/source.js';

/**
 * Schema v21's `request_window_covering_idx` is not observable in a return value, so
 * it is asserted in SQLite's query plan, against the SQL `entriesFrom` really prepares
 * rather than a copy kept here. The cover breaks silently when the index's column list
 * and `REQUEST_COLUMN_SET` drift apart — every other test still passes.
 */

const LIVE_DAY = '2026-07-15';
const ARCHIVED_DAY = '2026-07-10';

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

async function writeTriple(dir: string, iso: string): Promise<void> {
  const stem = stemFor(iso);
  const sidecar = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: 's-1', threadId: 't-covering', app: 'claude-code', userAgent: 'claude-cli/2.0' },
  };
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecar), 'utf8');
  await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, 'utf8');
  await writeFile(
    path.join(dir, `${stem}.request.txt`),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: `ask at ${iso}` }] }] }),
    'utf8',
  );
}

/** The same database, with every statement it prepares recorded. */
function recording(db: DatabaseSync) {
  const sql: string[] = [];
  const handle = new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (source: string) => {
          sql.push(source);
          return target.prepare(source);
        };
      }
      // SAFETY: `prop` came from a property access on this same object, so indexing
      // `target` with it yields whatever `DatabaseSync` declares at that key. These are
      // native methods and reject the proxy as a receiver, so they are forwarded bound.
      const value = target[prop as keyof DatabaseSync];
      return value instanceof Function ? value.bind(target) : value;
    },
  });
  return { handle, sql };
}

/** The one recorded statement that is the window read's main select. */
function windowSelect(sql: string[]): string {
  const found = sql.filter((s) => /^\s*SELECT\s+id,/.test(s) && /\bFROM request\b/.test(s));
  expect(found.length).toBeGreaterThan(0);
  // SAFETY: the expectation above fails the test before this index is read.
  return found[0]!;
}

/**
 * The plan SQLite chooses for a statement, as one string. The bind values are
 * placeholders — no predicate here plans differently for a different value.
 */
function planOf(db: DatabaseSync, sql: string): string {
  const holes = (sql.match(/\?/g) ?? []).length;
  const args = Array.from({ length: holes }, () => '2026-07-15');
  // SAFETY: every EXPLAIN QUERY PLAN row carries a `detail` string.
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join(' | ');
}

describe('the window read is answered from a covering index', () => {
  let logDir: string;
  let db: DatabaseSync;

  beforeAll(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'window-covering-'));
    const archiveDir = path.join(logDir, 'archive', ARCHIVED_DAY);
    await mkdir(archiveDir, { recursive: true });

    await writeTriple(logDir, `${LIVE_DAY}T14:00:00.000Z`);
    await writeTriple(logDir, `${LIVE_DAY}T15:00:00.000Z`);
    await writeTriple(archiveDir, `${ARCHIVED_DAY}T09:00:00.000Z`);

    db = openDb(logDir);
    await ingest(db, logDir);
  });

  afterAll(async () => {
    db?.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('stamps the current schema version and creates the index', () => {
    // The index arrived in v21 and every version since carries it, so the bar is
    // "at least v21" rather than "exactly v21" — pinning the literal made every
    // later bump fail here for no reason. v22 added `route_observation`.
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
    // SAFETY: `PRAGMA user_version` answers one row whose one column is named
    // `user_version`.
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);

    // SAFETY: the SELECT names exactly `name`, so every row carries it.
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'request'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(names).toContain('request_window_covering_idx');
  });

  it('covers exactly the columns the read selects, so neither list can drift', async () => {
    const { handle, sql } = recording(db);
    await dbSource(handle).readSidecars(logDir, { date: LIVE_DAY });

    const select = windowSelect(sql);
    // SAFETY: `windowSelect` matched `SELECT id, … FROM request`, so both markers are present.
    const selected = select
      .slice(select.indexOf('SELECT ') + 'SELECT '.length, select.indexOf(' FROM request'))
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    // SAFETY: `PRAGMA index_info` rows always carry a `name` column; it is null only
    // for an expression or rowid entry, and this index is column names throughout.
    const indexed = (db.prepare('PRAGMA index_info(request_window_covering_idx)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );

    // Order deliberately not compared: the index leads with the two predicate columns
    // while the select keeps `RequestRow`'s declaration order. Membership is what
    // makes it covering.
    expect([...indexed].sort()).toEqual([...selected].sort());
  });

  it('plans the per-day read as a covering index seek, with no temp B-tree', async () => {
    const { handle, sql } = recording(db);
    await dbSource(handle).readSidecars(logDir, { date: LIVE_DAY });

    const plan = planOf(db, windowSelect(sql));
    expect(plan).toContain('COVERING INDEX request_window_covering_idx');
    // The sort the index removes: before v21 this read sorted the whole day to
    // satisfy `ORDER BY`.
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('plans the whole-archive read as a covering index scan too', async () => {
    const { handle, sql } = recording(db);
    const source = dbSource(handle);
    // SAFETY: `dbSource` always implements `readAllDays`; the method is optional on
    // the interface only because the file backing has nothing better to offer.
    await source.readAllDays?.(logDir, [ARCHIVED_DAY], {});

    const plan = planOf(db, windowSelect(sql));
    // The read `ORDER BY source_dir, id` exists for: asked for `id` alone SQLite
    // scans the primary key instead.
    expect(plan).toContain('COVERING INDEX request_window_covering_idx');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
