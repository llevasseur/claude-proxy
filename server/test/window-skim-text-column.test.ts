import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource } from '../src/db/source.js';

/**
 * The window read does not carry `skim_text`.
 *
 * `request.skim_text` holds the last user turn of every request body — tens of
 * kilobytes a row, on nearly every row there is, which is more bytes than the whole
 * rest of the table put together. The window read selected it on every call because
 * the query was `SELECT *`, so a read that wanted token counts paid to drag the
 * corpus's prose out of SQLite and throw it away.
 *
 * These cases pin the fix from both sides, because only holding both makes it a fix
 * rather than a trade:
 *
 * - **The column stays out of the read that does not want it.** Asserted against the
 *   SQL actually prepared, not against a timing, so it cannot pass by being merely
 *   fast — and `SELECT *` is rejected by name, since reinstating it would restore the
 *   cost while every value assertion below still passed.
 * - **The fallback text still arrives for the read that does.** Including on the
 *   thread read, which reaches {@link entriesFrom} by a different call than the window
 *   does and has to forward the same flag to get the same answer.
 */

const DAY = '2026-07-15';
const KEPT = '2026-07-15T14:00:00.000Z';
const EVICTED = '2026-07-15T15:00:00.000Z';
const THREAD = 't-window-skim';

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

/** The audit sidecar plus the body ingest derives the skim text from. */
async function writeTriple(dir: string, iso: string): Promise<string> {
  const stem = stemFor(iso);
  const sidecar = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: 's-1', threadId: THREAD, app: 'claude-code', userAgent: 'claude-cli/2.0' },
  };
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecar), 'utf8');
  await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, 'utf8');
  await writeFile(
    path.join(dir, `${stem}.request.txt`),
    JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: `ask at ${iso}` }] }] }),
    'utf8',
  );
  return stem;
}

/**
 * The same database, with every statement it prepares recorded. A `Proxy` rather
 * than a stub because `dbSource` closes over the handle and calls more of it than a
 * stub would have to reimplement — this intercepts the one method under test and
 * forwards the rest untouched.
 */
function recording(db: DatabaseSync): { handle: DatabaseSync; sql: string[]; reset: () => void } {
  const sql: string[] = [];
  const handle = new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'prepare') {
        return (source: string) => {
          sql.push(source);
          return (value as DatabaseSync['prepare']).call(target, source);
        };
      }
      return value.bind(target);
    },
  });
  return { handle, sql, reset: () => sql.splice(0, sql.length) };
}

describe('the window read leaves skim_text behind', () => {
  let logDir: string;
  let db: DatabaseSync;
  let keptStem: string;
  let evictedStem: string;

  beforeAll(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'window-skim-'));
    keptStem = await writeTriple(logDir, KEPT);
    evictedStem = await writeTriple(logDir, EVICTED);
    db = openDb(logDir);
    await ingest(db, logDir);

    // Retention's half of the story: the body is gone, the derivative is not. This
    // is the one state in which `skim_text` is the only answer left.
    await rm(path.join(logDir, `${evictedStem}.md`), { force: true });
    await rm(path.join(logDir, `${evictedStem}.request.txt`), { force: true });
    await ingest(db, logDir);
  });

  afterAll(async () => {
    db?.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('never mentions the column when the read did not ask for the bodies', async () => {
    const { handle, sql } = recording(db);
    const read = await dbSource(handle).readSidecars(logDir, { date: DAY });

    expect(read.files).toBe(2);
    expect(sql.filter((s) => s.includes('skim_text'))).toEqual([]);
    // The guard that outlives this test: every value asserted below still holds
    // under `SELECT *`, so only naming it keeps the cost from coming back.
    expect(sql.filter((s) => /SELECT \*\s+FROM request\b/.test(s))).toEqual([]);
  });

  it('asks for the column once, and only for the rows that can consult it', async () => {
    const { handle, sql } = recording(db);
    await dbSource(handle).readSidecars(logDir, { date: DAY, includeSkimRequests: true });

    const skimQueries = sql.filter((s) => s.includes('skim_text'));
    expect(skimQueries).toHaveLength(1);
    // Narrowed to the two branches that read it — a derived body, or an evicted
    // one — rather than to the window, which is nearly every row in the corpus.
    expect(skimQueries[0]).toContain('body_derived = 1 OR request_path IS NULL');
  });

  it('still answers the text for a body retention has deleted', async () => {
    const read = await dbSource(db).readSidecars(logDir, {
      date: DAY,
      includeSkimRequests: true,
      includeFile: true,
    });
    // SAFETY: `includeFile: true` attaches `__file` (the stem) to every sidecar the
    // read returns, so both fields read here are present.
    const byFile = new Map((read.sidecars as Array<JsonObject>).map((s) => [s.__file as string, s.skimRequestText]));

    expect(byFile.get(evictedStem)).toBe(`ask at ${EVICTED}`);
    expect(byFile.get(keptStem)).toBe(`ask at ${KEPT}`);
    expect(read.bodiesEvicted).toBe(1);
  });

  it('answers it on the thread read too, which reaches the query by its own call', async () => {
    const source = dbSource(db);
    // SAFETY: `dbSource` always implements `readThread`; the method is optional on
    // the interface only because the file backing has nothing better to offer.
    const read = await source.readThread?.(logDir, THREAD, {
      date: DAY,
      includeSkimRequests: true,
      includeFile: true,
    });

    const sidecars = (read?.sidecars ?? []) as Array<JsonObject>;
    const byFile = new Map(sidecars.map((s) => [s.__file as string, s.skimRequestText]));
    expect(byFile.get(evictedStem)).toBe(`ask at ${EVICTED}`);
    expect(byFile.get(keptStem)).toBe(`ask at ${KEPT}`);
  });
});
