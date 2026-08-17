import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildUsage } from '../src/api.js';
import { ingest } from '../src/db/ingest.js';
import { openDb, resolveDbPath } from '../src/db/open.js';
import { dbSource, fileSource, type SidecarSource } from '../src/db/source.js';
import { clearArchivedUsageCache, clearLearnedCeilingsCache } from '../src/usage-history.js';

/**
 * The persisted half of the usage route's per-day cache: a row survives the
 * process that wrote it, so a restarted server does not re-parse 28 days of
 * archive for the first Overview load.
 *
 * "A restart" is {@link restart} throughout — the in-process maps go, the rows
 * stay, which is what a fresh process sees.
 */

/** 22:00 EDT on 2026-08-02, so `today()` is that day and the loops start at the 1st. */
const NOW = new Date('2026-08-03T02:00:00.000Z');

const CLOSED_DAY = '2026-08-01';
const CLOSED_ISO = '2026-08-01T15:00:00.000Z';

/** In the eight-day usage window, deliberately left off disk until a test adds it. */
const LATE_ISO = '2026-07-30T15:00:00.000Z';

const WEEK = { week: 10_000 };

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

async function archiveDay(logDir: string, iso: string): Promise<void> {
  await writeSidecar(path.join(logDir, 'archive', iso.slice(0, 10)), iso);
}

/** Everything a fresh process would not have, dropped; everything on disk kept. */
function restart(): void {
  clearLearnedCeilingsCache();
  clearArchivedUsageCache({ keepPersisted: true });
}

/** Any source, with a tally of which days its archived reads actually touched. */
function counting(inner: SidecarSource) {
  const archivedReads: string[] = [];
  return {
    archivedReads,
    // `satisfies` keeps the object's inferred shape while still giving the
    // `readArchivedDay` override's parameters `SidecarSource`'s own contextual types.
    source: {
      ...inner,
      readArchivedDay: (logDir, date, opts) => {
        archivedReads.push(date);
        return inner.readArchivedDay(logDir, date, opts);
      },
    } satisfies SidecarSource,
  };
}

let logDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'usage-day-store-'));
  await archiveDay(logDir, CLOSED_ISO);
  await writeSidecar(logDir, '2026-08-03T01:00:00.000Z'); // the live remainder of today
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
  db?.close();
});

describe('the persisted closed-day usage rows', () => {
  it('spares a restarted process the archived read for a closed day', async () => {
    const { source, archivedReads } = counting(fileSource);
    await buildUsage(logDir, WEEK, NOW, source);
    restart();
    await buildUsage(logDir, WEEK, NOW, source);

    expect(archivedReads.filter((d) => d === CLOSED_DAY)).toEqual([CLOSED_DAY]);
  });

  it('reads a day shared by the two spans once, not once each', async () => {
    // `loadArchivedUsage` and `loadLearnedCeilings` now run concurrently and
    // overlap by eight days; without the in-flight map they would miss together.
    const { source, archivedReads } = counting(fileSource);
    await buildUsage(logDir, WEEK, NOW, source);

    expect(archivedReads.filter((d) => d === CLOSED_DAY)).toEqual([CLOSED_DAY]);
  });

  it('answers a restarted process with the response it computed cold', async () => {
    const cold = await buildUsage(logDir, WEEK, NOW, fileSource);
    restart();
    const restarted = await buildUsage(logDir, WEEK, NOW, fileSource);

    expect(JSON.stringify(restarted)).toBe(JSON.stringify(cold));
  });

  it('counts a file it cannot use in meta.files after a restart, as it did cold', async () => {
    // The stored row keeps a `__file`-only placeholder for anything the meters
    // cannot read, because `meta.files` is the length of that stream.
    await writeFile(path.join(logDir, 'archive', CLOSED_DAY, 'broken_anthropic.audit.json'), '{oops', 'utf8');

    const cold = await buildUsage(logDir, WEEK, NOW, fileSource);
    restart();
    const restarted = await buildUsage(logDir, WEEK, NOW, fileSource);

    expect(restarted.meta.files).toBe(cold.meta.files);
    expect(restarted.meta.parseErrors).toBe(cold.meta.parseErrors);
  });

  it('never persists a miss, so a day can still gain its archive later', async () => {
    const first = await buildUsage(logDir, WEEK, NOW, fileSource);

    await archiveDay(logDir, LATE_ISO);
    restart();
    const second = await buildUsage(logDir, WEEK, NOW, fileSource);

    // A day with no directory is not stored as an empty one: it is read again,
    // finds the archive the job has since written, and counts.
    expect(second.meta.files).toBe(first.meta.files + 1);
  });

  it('keeps the two backings on separate rows', async () => {
    await buildUsage(logDir, WEEK, NOW, fileSource);
    restart();

    const { source, archivedReads } = counting(dbSource(db));
    await buildUsage(logDir, WEEK, NOW, source);

    // A file-backed row answering a DB-backed read would have the parity harness
    // compare one backing's work against itself.
    expect(archivedReads).toContain(CLOSED_DAY);
  });

  it('leaves a log directory with no database without one', async () => {
    const bare = await mkdtemp(path.join(tmpdir(), 'usage-day-store-bare-'));
    await archiveDay(bare, CLOSED_ISO);

    await buildUsage(bare, WEEK, NOW, fileSource);

    expect(existsSync(resolveDbPath(bare))).toBe(false);
  });
});
