import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { ALL_DAYS, dbSource, fileSource, readWindow, resolveAllDays } from '../src/db/source.js';

/**
 * `all: true` is the floor `readWindow` was never given. It has to be a window
 * like any other — same composition, same `byDay`, same counts — and the two
 * backings have to agree on it, because they resolve the floor by different
 * means: a directory listing on one side, an indexed `MIN` on the other.
 *
 * The DB side additionally answers it without the per-day walk, which is the
 * only reason an all-time span is affordable at all. That is pinned here by
 * counting the walk's calls, not by timing anything.
 */

/** 22:00 EDT on the newest reporting day, so that day is open and still live. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';

/** Far enough back that no bounded picker window would ever have reached it. */
const OLDEST_DAY = '2026-05-04';
const MIDDLE_DAY = '2026-06-15';
const RECENT_DAY = '2026-08-01';

/** 11:00 EDT — the reporting day matches the UTC day the file is named for. */
function morning(day: string): string {
  return `${day}T15:00:00.000Z`;
}

/** 21:00 EDT on `day`, which is the *next* UTC day, so it stays in the live root. */
function evening(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T01:00:00.000Z`;
}

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

async function writeSidecar(dir: string, iso: string, realInput: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), JSON.stringify(body), 'utf8');
}

let logDir: string;
let db: DatabaseSync;

/**
 * Three archived days spread months apart, a fourth day split across the seam,
 * and today still live — the shape only an all-time window can see whole.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'all-time-window-'));
  await writeSidecar(path.join(logDir, 'archive', OLDEST_DAY), morning(OLDEST_DAY), 10_000);
  await writeSidecar(path.join(logDir, 'archive', MIDDLE_DAY), morning(MIDDLE_DAY), 20_000);
  await writeSidecar(path.join(logDir, 'archive', RECENT_DAY), morning(RECENT_DAY), 30_000);
  // The newest reporting day, half rotated out and half not.
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY), 40_000);
  await writeSidecar(logDir, evening(TODAY), 50_000);
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  db?.close();
});

/** A window read reduced to something comparable; `byDay` is a Map, so it is flattened. */
function comparableOf(result: Awaited<ReturnType<typeof readWindow>>) {
  return {
    sidecars: result.sidecars,
    files: result.files,
    parseErrors: result.parseErrors,
    bodiesEvicted: result.bodiesEvicted,
    archivedDays: result.archivedDays,
    days: result.days,
    byDay: [...result.byDay].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

describe('an all-time window', () => {
  it('reaches the oldest archived day instead of the live root alone', async () => {
    const { files, archivedDays, days, sidecars } = await readWindow(logDir, { all: true }, NOW);

    expect(files).toBe(5);
    expect(archivedDays).toBe(4);
    // One day back off the oldest name on disk, because a reporting day lags the
    // UTC day its files are named for.
    expect(days[0]).toBe('2026-05-03');
    expect(days.at(-1)).toBe(TODAY);
    // SAFETY: `readWindow`'s `sidecars` is `unknown[]` in general, but this corpus's
    // `beforeEach` wrote only well-formed `writeSidecar(...)` bodies, each carrying the
    // `timestamp` it was written with.
    expect(sidecars.map((s) => (s as { timestamp: string }).timestamp)).toEqual([
      morning(OLDEST_DAY),
      morning(MIDDLE_DAY),
      morning(RECENT_DAY),
      morning(TODAY),
      evening(TODAY),
    ]);
  });

  it('groups every day it covered, archived or live', async () => {
    const { byDay } = await readWindow(logDir, { all: true }, NOW);

    expect([...byDay.keys()].sort()).toEqual([OLDEST_DAY, MIDDLE_DAY, RECENT_DAY, TODAY]);
    // The split day is read from both halves and lands in one bucket.
    expect(byDay.get(TODAY)).toHaveLength(2);
  });

  it('defers to a span the caller actually named', async () => {
    const bounded = await readWindow(logDir, { all: true, sinceDays: 2 }, NOW);
    expect(bounded.days).toEqual([RECENT_DAY, TODAY]);
    // The two newest days only — the archived days months back stay out.
    expect(bounded.files).toBe(3);
  });

  it('answers an empty corpus with today rather than erroring or walking nothing', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'all-time-empty-'));
    const { files, days, archivedDays } = await readWindow(empty, { all: true }, NOW);

    expect(days).toEqual([TODAY]);
    expect(archivedDays).toBe(0);
    expect(files).toBe(0);
  });

  it('still reads the live root alone when nothing asked for a floor', async () => {
    const { days, files } = await readWindow(logDir, {}, NOW);

    expect(days).toEqual([]);
    expect(files).toBe(1);
  });
});

describe('the two backings agree on the all-time answer', () => {
  it('composes the same window through files and through the substrate', async () => {
    const fromFiles = await readWindow(logDir, { all: true }, NOW, fileSource);
    const fromDb = await readWindow(logDir, { all: true }, NOW, dbSource(db));

    expect(comparableOf(fromDb)).toEqual(comparableOf(fromFiles));
    expect(fromDb.files).toBe(5);
  });

  it('resolves the same floor from a listing and from an indexed MIN', async () => {
    expect(await dbSource(db).oldestDay(logDir)).toBe(await fileSource.oldestDay(logDir));
    expect(await fileSource.oldestDay(logDir)).toBe('2026-05-03');
  });

  it('agrees on the concrete day count the routes hand the builders', async () => {
    const fromFiles = await resolveAllDays(logDir, ALL_DAYS, NOW, fileSource);
    const fromDb = await resolveAllDays(logDir, ALL_DAYS, NOW, dbSource(db));

    expect(fromDb).toBe(fromFiles);
    // 2026-05-03 through 2026-08-02, both ends counted.
    expect(fromFiles).toBe(92);
  });

  it('leaves a concrete day count exactly as it was asked for', async () => {
    expect(await resolveAllDays(logDir, 30, NOW, fileSource)).toBe(30);
  });
});

describe('the substrate answers all-time as a read, not a walk', () => {
  it('never asks for a day at a time, however many days the span covers', async () => {
    const source = dbSource(db);
    let perDayReads = 0;
    const counting = {
      ...source,
      readArchivedDay: (...args: Parameters<typeof source.readArchivedDay>) => {
        perDayReads += 1;
        return source.readArchivedDay(...args);
      },
    };

    const { files, days } = await readWindow(logDir, { all: true }, NOW, counting);

    expect(days.length).toBeGreaterThan(90);
    expect(files).toBe(5);
    expect(perDayReads).toBe(0);
  });

  it('keeps the per-day walk for a bounded span, which is unchanged', async () => {
    const source = dbSource(db);
    let perDayReads = 0;
    const counting = {
      ...source,
      readArchivedDay: (...args: Parameters<typeof source.readArchivedDay>) => {
        perDayReads += 1;
        return source.readArchivedDay(...args);
      },
    };

    await readWindow(logDir, { sinceDays: 7 }, NOW, counting);
    expect(perDayReads).toBe(7);
  });
});
