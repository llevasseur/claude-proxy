import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { buildContext, contextPageQuery } from '../src/api.js';
import { clearContextDayMemo } from '../src/context-day-memo.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * `/api/context` used to read every sidecar in its window on every request — and
 * the table asks again for a sort click, a page click and each search keystroke.
 * A reporting day that has closed can no longer gain a request, so it is reduced
 * once and kept: in this process, and in a `context_day` row the next one reads.
 *
 * Three things have to hold together, and each is pinned below. The answer must
 * not change, backing for backing. A closed day must be read from the corpus
 * exactly once, however many times the page is asked for. And the day still in
 * progress must be read every time, because it is still moving.
 */

/** 22:00 EDT on the newest reporting day, so that day is open and still live. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const CLOSED_DAY = '2026-08-01';
const OLDER_DAY = '2026-07-31';

/** 11:00 EDT — the reporting day matches the UTC day the file is named for. */
function morning(day: string, hour = 15): string {
  return `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
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

async function writeSidecar(dir: string, iso: string, realInput: number, threadId: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const body: JsonObject = {
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
 * Two archived days that have closed, plus the day in progress — half of it
 * archived and half of it still live, which is the seam a reporting day near the
 * present genuinely sits across.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-day-cache-'));
  await writeSidecar(path.join(logDir, 'archive', OLDER_DAY), morning(OLDER_DAY), 11_000, 'aaaa');
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), morning(CLOSED_DAY), 22_000, 'bbbb');
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), morning(CLOSED_DAY, 16), 33_000, 'cccc');
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY), 44_000, 'dddd');
  await writeSidecar(logDir, evening(TODAY), 55_000, 'eeee');
  db = openDb(logDir);
  await ingest(db, logDir);
  clearContextDayMemo();
});

afterEach(() => {
  clearContextDayMemo();
  db?.close();
});

/** Wraps a backing so every corpus read it is asked for is counted, by day. */
function counting(source: SidecarSource) {
  const archived: string[] = [];
  const live: (string | undefined)[] = [];
  const wrapped: SidecarSource = {
    ...source,
    readArchivedDay: (logDirArg, date, opts) => {
      archived.push(date);
      return source.readArchivedDay(logDirArg, date, opts);
    },
    readSidecars: (logDirArg, opts, now) => {
      live.push(opts?.date);
      return source.readSidecars(logDirArg, opts, now);
    },
  };
  return { source: wrapped, archived, live };
}

describe('the context window read as its days', () => {
  it('reads a closed day from the corpus once, however often the page is asked for', async () => {
    const { source, archived } = counting(dbSource(db));

    const first = await buildContext(logDir, 3, NOW, source, contextPageQuery());
    expect(archived).toContain(CLOSED_DAY);

    archived.length = 0;
    // A sort click and a search keystroke — the two repeats that used to re-read
    // the whole window.
    await buildContext(logDir, 3, NOW, source, contextPageQuery({ sort: 'realInput', dir: 'asc' }));
    await buildContext(logDir, 3, NOW, source, contextPageQuery({ q: 'nothing matches this' }));

    // The closed days are never read again. Today still is, on every request.
    expect(archived).not.toContain(CLOSED_DAY);
    expect(archived).not.toContain(OLDER_DAY);
    expect(archived.filter((d) => d === TODAY)).toHaveLength(2);
    expect(first.summary.requestCount).toBe(5);
  });

  it('keeps recomputing the day that is still half live', async () => {
    const { source, live } = counting(dbSource(db));

    await buildContext(logDir, 3, NOW, source, contextPageQuery());
    live.length = 0;
    await buildContext(logDir, 3, NOW, source, contextPageQuery());

    // Only today's live half is read on the second pass — the closed days are
    // answered entirely from their stored aggregates.
    expect(live).toEqual([TODAY]);
  });

  it('finds a closed day a previous process stored, without reading it again', async () => {
    await buildContext(logDir, 3, NOW, dbSource(db), contextPageQuery());

    // A restart: the in-process map goes, the `context_day` rows stay.
    clearContextDayMemo({ keepPersisted: true });

    const { source, archived } = counting(dbSource(db));
    const cold = await buildContext(logDir, 3, NOW, source, contextPageQuery());

    expect(archived).not.toContain(CLOSED_DAY);
    expect(archived).not.toContain(OLDER_DAY);
    expect(cold.summary.requestCount).toBe(5);
  });

  it('answers the same window whether the days were cached or read cold', async () => {
    const cold = await buildContext(logDir, 3, NOW, dbSource(db), contextPageQuery());
    const warm = await buildContext(logDir, 3, NOW, dbSource(db), contextPageQuery());

    expect(warm).toEqual(cold);
    // Newest thread first by default, and every day of the window in the answer.
    expect(cold.page.rows.map((r) => r.threadId)).toEqual(['eeee', 'dddd', 'cccc', 'bbbb', 'aaaa']);
    expect(cold.meta.files).toBe(5);
  });

  it('agrees between the two backings, cached rows and all', async () => {
    const fromFiles = await buildContext(logDir, 30, NOW, fileSource, contextPageQuery());
    const fromDb = await buildContext(logDir, 30, NOW, dbSource(db), contextPageQuery());

    expect(fromDb).toEqual(fromFiles);
    // And again now that both backings have their days stored — the row key
    // carries the backing, so neither can be served the other's answer.
    expect(await buildContext(logDir, 30, NOW, dbSource(db), contextPageQuery())).toEqual(fromFiles);
  });
});
