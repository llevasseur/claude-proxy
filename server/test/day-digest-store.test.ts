import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSummary, buildTrends } from '../src/api.js';
import { clearDayDigestMemo } from '../src/day-digest-memo.js';
import { ingest } from '../src/db/ingest.js';
import { openDb, resolveDbPath } from '../src/db/open.js';
import { dbSource, fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * The persisted half of the closed-day digest cache: a row survives the process
 * that wrote it, so a restarted server does not rescan the corpus for the first
 * read of a day that can no longer change.
 *
 * "A restart" is `clearDayDigestMemo({ keepPersisted: true })` throughout — the
 * in-process map goes, the rows stay, which is exactly what a fresh process sees.
 */

/** 11:00 EDT on 2026-08-02 — already rotated into `archive/2026-08-02/`. */
const TODAY_ARCHIVED_ISO = '2026-08-02T15:00:00.000Z';
/** 21:00 EDT the same reporting day, but the next UTC day — so still live. */
const TODAY_LIVE_ISO = '2026-08-03T01:00:00.000Z';
/** A day that rotated out whole, with no live remainder. */
const CLOSED_ISO = '2026-08-01T15:00:00.000Z';

const OPEN_DAY = '2026-08-02';
const CLOSED_DAY = '2026-08-01';

/** 22:00 EDT on 2026-08-02, so `today()` is that day and it is still open. */
const NOW = new Date('2026-08-03T02:00:00.000Z');

const TOKENS = { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 };

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

async function writeSidecar(dir: string, iso: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: TOKENS,
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), JSON.stringify(body), 'utf8');
}

/** Any source, with a tally of which days its archived reads actually touched. */
function counting(inner: SidecarSource): { source: SidecarSource; archivedReads: string[] } {
  const archivedReads: string[] = [];
  return {
    archivedReads,
    source: {
      ...inner,
      readArchivedDay: (logDir, date, opts) => {
        archivedReads.push(date);
        return inner.readArchivedDay(logDir, date, opts);
      },
    },
  };
}

let logDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'day-digest-store-'));
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), CLOSED_ISO);
  await writeSidecar(path.join(logDir, 'archive', OPEN_DAY), TODAY_ARCHIVED_ISO);
  await writeSidecar(logDir, TODAY_LIVE_ISO);
  clearDayDigestMemo();
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  clearDayDigestMemo();
  db?.close();
});

describe('the persisted closed-day digest', () => {
  it('spares a restarted process the archived read for a closed day', async () => {
    const { source, archivedReads } = counting(fileSource);
    await buildTrends(logDir, 3, NOW, undefined, source);
    clearDayDigestMemo({ keepPersisted: true });
    await buildTrends(logDir, 3, NOW, undefined, source);

    expect(archivedReads.filter((d) => d === CLOSED_DAY)).toEqual([CLOSED_DAY]);
  });

  it('answers a restarted process with the same digest it computed cold', async () => {
    const cold = await buildTrends(logDir, 3, NOW, undefined, fileSource);
    clearDayDigestMemo({ keepPersisted: true });
    const restarted = await buildTrends(logDir, 3, NOW, undefined, fileSource);

    expect(JSON.stringify(restarted)).toBe(JSON.stringify(cold));
  });

  it('serves the summary baseline from a row an earlier process wrote', async () => {
    await buildTrends(logDir, 3, NOW, undefined, fileSource);
    clearDayDigestMemo({ keepPersisted: true });

    const { source, archivedReads } = counting(fileSource);
    const summary = await buildSummary(logDir, OPEN_DAY, NOW, undefined, source);

    expect(archivedReads).not.toContain(CLOSED_DAY);
    expect(summary.digest.date).toBe(OPEN_DAY);
  });

  it('never persists the day in progress — it is re-read after a restart', async () => {
    const { source, archivedReads } = counting(fileSource);
    await buildTrends(logDir, 3, NOW, undefined, source);
    clearDayDigestMemo({ keepPersisted: true });
    await buildTrends(logDir, 3, NOW, undefined, source);

    expect(archivedReads.filter((d) => d === OPEN_DAY)).toEqual([OPEN_DAY, OPEN_DAY]);
  });

  it('never persists a miss, so a day can still gain its archive later', async () => {
    const { source, archivedReads } = counting(fileSource);
    await buildTrends(logDir, 4, NOW, undefined, source);
    clearDayDigestMemo({ keepPersisted: true });
    await buildTrends(logDir, 4, NOW, undefined, source);

    // 2026-07-31 is in the window and on record nowhere: a miss, read both times.
    expect(archivedReads.filter((d) => d === '2026-07-31')).toHaveLength(2);
  });

  it('keeps the two backings on separate rows', async () => {
    await buildTrends(logDir, 3, NOW, undefined, fileSource);
    clearDayDigestMemo({ keepPersisted: true });

    const { source, archivedReads } = counting(dbSource(db));
    await buildTrends(logDir, 3, NOW, undefined, source);

    // The file-backed row must not answer for the DB-backed read, or the parity
    // harness would compare one backing's work against itself.
    expect(archivedReads).toContain(CLOSED_DAY);
  });

  it('leaves a log directory with no database without one', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'day-digest-store-bare-'));
    await writeSidecar(path.join(bare, 'archive', CLOSED_DAY), CLOSED_ISO);

    await buildTrends(bare, 3, NOW, undefined, fileSource);

    expect(existsSync(resolveDbPath(bare))).toBe(false);
  });
});
