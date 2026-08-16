import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext } from '../src/api.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, readWindow } from '../src/db/source.js';

/**
 * `/api/context` wants the window in time order, and used to get there by
 * sorting the whole window in JavaScript — ~630,000 comparisons over a 30-day
 * span. `orderByTimestamp` asks the read for that order instead.
 *
 * The corpus below is built so the order is not free: a reporting day near the
 * present sits in **both** halves, and the archived half holds a request that
 * came *later* than one still in the live root. Archived-then-live therefore
 * reads out of order for that day, which is precisely what the old sort existed
 * to repair — so a test whose corpus lacks that overlap would pass against a
 * read that does nothing at all.
 *
 * Both backings are pinned against each other throughout: `/api/context` is
 * compared byte-for-byte across them by the parity harness, so an order that
 * only one of them applies would be a divergence rather than a speed-up.
 */

/** 22:00 EDT on the newest reporting day, so that day is open and still live. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const RECENT_DAY = '2026-08-01';

/** `HH:00Z` on `day`. Every hour used here lands inside `day`'s reporting day. */
function at(day: string, hour: number): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
}

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

async function writeSidecar(dir: string, iso: string, realInput: number, threadId: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
    session: { sessionId: `session-of-${threadId}`, threadId },
  };
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), JSON.stringify(body), 'utf8');
}

let logDir: string;
let db: DatabaseSync;

/**
 * Reporting day `TODAY` straddles the archive: 12:00 and 20:00 were archived,
 * 15:00 and 17:00 are still live. Read archived-half-first, that day comes back
 * `12, 20, 15, 17` — three of the four out of order.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-window-order-'));
  await writeSidecar(path.join(logDir, 'archive', RECENT_DAY), at(RECENT_DAY, 14), 11_000, 'aaaaaaaaaaaaaaaa');
  await writeSidecar(path.join(logDir, 'archive', TODAY), at(TODAY, 12), 22_000, 'bbbbbbbbbbbbbbbb');
  await writeSidecar(path.join(logDir, 'archive', TODAY), at(TODAY, 20), 33_000, 'cccccccccccccccc');
  await writeSidecar(logDir, at(TODAY, 15), 44_000, 'dddddddddddddddd');
  await writeSidecar(logDir, at(TODAY, 17), 55_000, 'eeeeeeeeeeeeeeee');
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  db?.close();
});

const CHRONOLOGICAL = [at(RECENT_DAY, 14), at(TODAY, 12), at(TODAY, 15), at(TODAY, 17), at(TODAY, 20)];
/** What archived-half-first produces: the live root's two rows pushed to the end. */
const READ_ORDER = [at(RECENT_DAY, 14), at(TODAY, 12), at(TODAY, 20), at(TODAY, 15), at(TODAY, 17)];

function timestamps(sidecars: readonly unknown[]): string[] {
  return sidecars.map((s) => (s as { timestamp: string }).timestamp);
}

describe('an ordered window read', () => {
  it('is not the order the halves are read in — the seam really is out of order', async () => {
    const plain = await readWindow(logDir, { sinceDays: 30 }, NOW, fileSource);

    expect(timestamps(plain.sidecars)).toEqual(READ_ORDER);
    expect(timestamps(plain.sidecars)).not.toEqual(CHRONOLOGICAL);
  });

  it('merges the archived and live halves into one chronological stream', async () => {
    for (const [name, source] of [
      ['files', fileSource],
      ['substrate', dbSource(db)],
    ] as const) {
      const ordered = await readWindow(logDir, { sinceDays: 30, orderByTimestamp: true }, NOW, source);

      expect(timestamps(ordered.sidecars), name).toEqual(CHRONOLOGICAL);
    }
  });

  it('orders the all-days read too, which answers the archive in one query', async () => {
    const fromFiles = await readWindow(logDir, { all: true, orderByTimestamp: true }, NOW, fileSource);
    const fromDb = await readWindow(logDir, { all: true, orderByTimestamp: true }, NOW, dbSource(db));

    expect(timestamps(fromDb.sidecars)).toEqual(CHRONOLOGICAL);
    expect(timestamps(fromDb.sidecars)).toEqual(timestamps(fromFiles.sidecars));
  });

  it('leaves the count and the day buckets exactly as they were', async () => {
    const plain = await readWindow(logDir, { sinceDays: 30 }, NOW, dbSource(db));
    const ordered = await readWindow(logDir, { sinceDays: 30, orderByTimestamp: true }, NOW, dbSource(db));

    expect(ordered.files).toBe(plain.files);
    expect(ordered.parseErrors).toBe(plain.parseErrors);
    expect(ordered.archivedDays).toBe(plain.archivedDays);
    // Keyed by reporting day, so a day holds the same rows whichever half they
    // came from — the flag reorders the stream, not the buckets.
    expect([...ordered.byDay.keys()]).toEqual([...plain.byDay.keys()]);
    for (const day of ordered.byDay.keys()) {
      expect(timestamps(ordered.byDay.get(day)!), day).toEqual(timestamps(plain.byDay.get(day)!));
    }
  });

  it('changes nothing when the caller does not ask for it', async () => {
    const fromFiles = await readWindow(logDir, { sinceDays: 30 }, NOW, fileSource);
    const fromDb = await readWindow(logDir, { sinceDays: 30 }, NOW, dbSource(db));

    expect(timestamps(fromDb.sidecars)).toEqual(READ_ORDER);
    expect(timestamps(fromDb.sidecars)).toEqual(timestamps(fromFiles.sidecars));
  });
});

describe('the context route on top of it', () => {
  it('groups threads from the chronological stream, without sorting it itself', async () => {
    const ctx = await buildContext(logDir, 30, NOW, dbSource(db));

    // `firstTimestamp` is read off each thread's earliest request, which is only
    // right if the stream reaching `groupContextThreads` is in time order.
    expect(ctx.page.rows.map((r) => r.firstTimestamp).sort()).toEqual(CHRONOLOGICAL);
    expect(ctx.meta.files).toBe(5);
    expect(ctx.summary.requestCount).toBe(5);
    // The aggregate now reads a chronological stream rather than an
    // archived-half-first one. It is the same set either way, so everything
    // that does not depend on order is untouched.
    expect(ctx.summary.maxRealInput).toBe(55_000);
    expect(ctx.summary.top.map((e) => e.realInput)).toEqual([55_000, 44_000, 33_000, 22_000, 11_000]);
  });

  it('answers identically through files and through the substrate', async () => {
    const fromFiles = await buildContext(logDir, 30, NOW, fileSource);
    const fromDb = await buildContext(logDir, 30, NOW, dbSource(db));

    expect(fromDb).toEqual(fromFiles);
  });
});
