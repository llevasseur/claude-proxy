import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { openDb, resolveDbPath } from '../src/db/open.js';
import { dbSource, fileSource } from '../src/db/source.js';

/**
 * An evicted day still answers the skim text.
 *
 * Retention is documented as lossless for metrics, and it is — for anything read
 * out of a sidecar. `/api/skim` is the exception: it opened the `.request.txt` at
 * query time for the last user turn, so past the retention edge that view degraded
 * silently while the usage views did not. Ingest now reads the body for that value
 * while it is still on disk, into `request.skim_text`.
 *
 * These cases pin down both halves of the guarantee, because both are load-bearing:
 *
 * - **Forward.** A body derived and *then* evicted still answers, and the eviction
 *   is still counted — the count is a live disk observation on either backing.
 * - **Backward, and it does not hold.** A body evicted before anything derived it
 *   is gone, and re-ingesting cannot invent the derivative. Total recovery
 *   (`rm logs/claude-proxy.db && pnpm --filter server ingest`) still reconstructs
 *   everything that is *on disk*, which is the property ADR 0004 requires and the
 *   reason this is columns of bounded strings rather than a blob store.
 */

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

function sidecarBody(iso: string): Record<string, unknown> {
  return {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: '/v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: 's-1', app: 'claude-code', userAgent: 'claude-cli/2.0' },
    skim: { enabled: true, servedFromCache: false, savedInputTokens: 0, cacheKey: null },
  };
}

/** The audit sidecar plus the two bodies retention later deletes. */
async function writeTriple(dir: string, iso: string, opts: { body?: string | false } = {}): Promise<string> {
  const stem = stemFor(iso);
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(sidecarBody(iso)), 'utf8');
  if (opts.body !== false) {
    await writeFile(path.join(dir, `${stem}.md`), `# ${iso}\n`, 'utf8');
    await writeFile(
      path.join(dir, `${stem}.request.txt`),
      opts.body ?? JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: `ask at ${iso}` }] }] }),
      'utf8',
    );
  }
  return stem;
}

/** Evict exactly what `applyRetention` evicts: the two bodies, never the sidecar. */
async function evict(dir: string, stem: string): Promise<void> {
  await rm(path.join(dir, `${stem}.md`), { force: true });
  await rm(path.join(dir, `${stem}.request.txt`), { force: true });
}

const DAY = '2026-07-15';
const KEPT = '2026-07-15T14:00:00.000Z';
const BROKEN = '2026-07-15T15:00:00.000Z';
const ALREADY_GONE = '2026-07-15T16:00:00.000Z';

describe('deriving a body before eviction removes it', () => {
  let logDir: string;
  let dayDir: string;
  let db: DatabaseSync;
  let keptStem: string;
  let brokenStem: string;
  let goneStem: string;

  beforeAll(async () => {
    logDir = await mkdtemp(path.join(tmpdir(), 'derive-'));
    dayDir = path.join(logDir, 'archive', DAY);
    await mkdir(dayDir, { recursive: true });
    keptStem = await writeTriple(dayDir, KEPT);
    // A body that is there but is not JSON. It derives a real null, and marking
    // it settled is what stops every later pass re-reading it.
    brokenStem = await writeTriple(dayDir, BROKEN, { body: '{ not json' });
    // Evicted before this feature ever ran: no body was ever seen.
    goneStem = await writeTriple(dayDir, ALREADY_GONE, { body: false });
    db = openDb(logDir);
    await ingest(db, logDir);
  });

  afterAll(async () => {
    db?.close();
    await rm(logDir, { recursive: true, force: true });
  });

  it('extracts the text into a column while the body is still on disk', () => {
    const rows = db
      .prepare('SELECT id, skim_text, body_derived, blob_evicted FROM request ORDER BY id')
      .all() as Array<{ id: string; skim_text: string | null; body_derived: number; blob_evicted: number }>;
    expect(rows.map((r) => [r.id, r.skim_text, r.body_derived, r.blob_evicted])).toEqual([
      [keptStem, `ask at ${KEPT}`, 1, 0],
      // Present but unparseable: derived, with a null derivative. Same answer the
      // file backing gives for the same file.
      [brokenStem, null, 1, 0],
      // No body was ever there to read, so nothing was derived and the row is
      // already on the ledger as evicted.
      [goneStem, null, 0, 1],
    ]);
  });

  it('does not re-read a body it has already derived', async () => {
    const stats = await ingest(db, logDir);
    expect(stats.derived).toBe(0);
  });

  it('still answers the skim text after retention deletes the body', async () => {
    await evict(dayDir, keptStem);
    await evict(dayDir, brokenStem);
    await ingest(db, logDir);

    // The derivative survived the body it came from.
    expect(
      (db.prepare('SELECT skim_text FROM request WHERE id = ?').get(keptStem) as { skim_text: string }).skim_text,
    ).toBe(`ask at ${KEPT}`);

    const fromDb = await dbSource(db).readArchivedDay(logDir, DAY, { includeSkimRequests: true, includeFile: true });
    const byFile = new Map(
      (fromDb.sidecars as Array<Record<string, unknown>>).map((s) => [s.__file as string, s.skimRequestText]),
    );
    expect(byFile.get(keptStem)).toBe(`ask at ${KEPT}`);
    expect(byFile.get(brokenStem)).toBeUndefined();
    expect(byFile.get(goneStem)).toBeUndefined();

    // The count is still a live disk observation rather than a column read, and
    // that is load-bearing here: an archived day whose audit listing is unchanged
    // is skipped wholesale by its watermark, so `blob_evicted` on the row has not
    // caught up with the deletion. The read still sees all three bodies gone, and
    // both backings agree on the number.
    expect(fromDb.bodiesEvicted).toBe(3);
    expect((db.prepare('SELECT count(*) c FROM request WHERE blob_evicted = 1').get() as { c: number }).c).toBe(1);

    // This is the degradation the change is about: the file scan opens the body at
    // query time, so it has nothing left to answer with.
    const fromFiles = await fileSource.readArchivedDay(logDir, DAY, { includeSkimRequests: true, includeFile: true });
    expect(fromFiles.bodiesEvicted).toBe(3);
    for (const sidecar of fromFiles.sidecars as Array<Record<string, unknown>>) {
      expect(sidecar.skimRequestText).toBeUndefined();
    }
  });

  it('is forward-only: a rebuild from disk cannot recover a derivative whose body is gone', async () => {
    // Total recovery, exactly as the ADR states it.
    db.close();
    await rm(resolveDbPath(logDir), { force: true });
    await rm(`${resolveDbPath(logDir)}-wal`, { force: true });
    await rm(`${resolveDbPath(logDir)}-shm`, { force: true });
    db = openDb(logDir);
    const stats = await ingest(db, logDir);

    // Everything that is on disk came back: three sidecars, their metrics, and
    // their eviction state.
    expect((db.prepare('SELECT count(*) c FROM request').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT count(*) c FROM request WHERE blob_evicted = 1').get() as { c: number }).c).toBe(3);
    // And nothing was derived, because there is no longer a body to derive from.
    expect(stats.derived).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM request WHERE body_derived = 1').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT count(*) c FROM request WHERE skim_text IS NOT NULL').get() as { c: number }).c).toBe(0);
  });
});
