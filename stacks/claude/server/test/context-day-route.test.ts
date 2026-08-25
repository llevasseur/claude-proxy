import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { mergeContextDays } from '@agent-proxy/claude-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { buildContext, buildContextDay, contextPageQuery } from '../src/api.js';
import { clearContextDayMemo } from '../src/context-day-memo.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * `/api/context/day` is one term of the sum `/api/context` ships whole.
 *
 * Three things are pinned below: summing the days lands on exactly what the window route
 * answers; `closed` is the server's own vouch, and so is false for the day in progress;
 * and `since` names the corpus floor a browser cannot compute, on the open day alone.
 */

/** 22:00 EDT on the newest reporting day, so that day is open and still live. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const CLOSED_DAY = '2026-08-01';
const OLDER_DAY = '2026-07-31';
/** The window those three days are exactly the span of. */
const WINDOW = [OLDER_DAY, CLOSED_DAY, TODAY];

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
 * Two archived days that have closed, plus the day in progress — half archived and half
 * still live, the seam a reporting day near the present sits across. The same corpus
 * `context-day-cache.test.ts` uses.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-day-route-'));
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

const backings: [string, () => SidecarSource][] = [
  ['files', () => fileSource],
  ['db', () => dbSource(db)],
];

describe.each(backings)('/api/context/day over the %s backing', (_name, sourceOf) => {
  it('sums to exactly what the window route answers for the same span', async () => {
    const source = sourceOf();
    const whole = await buildContext(logDir, WINDOW.length, NOW, source, contextPageQuery());
    const days = await Promise.all(WINDOW.map((date) => buildContextDay(logDir, date, NOW, source)));

    // Oldest first, which is what fixes every tie-break the merge reproduces.
    const folded = mergeContextDays(days.map((day) => day.aggregate));

    expect(folded.aggregates).toEqual(whole.summary);
    // The window route's default page is the whole index in `when`-descending order,
    // so the rows a browser would draw from the fold are the rows it shipped.
    expect(folded.rows).toHaveLength(whole.page.total);
    expect(days.reduce((n, day) => n + day.meta.files, 0)).toBe(whole.meta.files);
    expect(days.reduce((n, day) => n + day.meta.parseErrors, 0)).toBe(whole.meta.parseErrors);
  });

  it('vouches for a day that has closed, and never for the day in progress', async () => {
    const source = sourceOf();
    expect((await buildContextDay(logDir, OLDER_DAY, NOW, source)).closed).toBe(true);
    expect((await buildContextDay(logDir, CLOSED_DAY, NOW, source)).closed).toBe(true);
    // Still split across the live root and the archive, so it is not settled even
    // though it is the day a reader is looking at.
    expect((await buildContextDay(logDir, TODAY, NOW, source)).closed).toBe(false);
  });

  it('answers the day in progress when no date is named, and only it reports the floor', async () => {
    const source = sourceOf();
    const anchor = await buildContextDay(logDir, undefined, NOW, source);

    expect(anchor.date).toBe(TODAY);
    expect(anchor.closed).toBe(false);
    // The floor the `All` window is composed from. It is corpus-scoped rather than
    // day-scoped, so it rides only on the one response nothing may cache — a dated day
    // may be held forever, and a floor pinned there would outlive retention moving it.
    expect(anchor.since).not.toBeNull();
    expect(anchor.since! <= OLDER_DAY).toBe(true);
    expect((await buildContextDay(logDir, OLDER_DAY, NOW, source)).since).toBeNull();
  });
});

describe('the two backings answer the same day', () => {
  it('agrees field for field, so the fold does not depend on which one served it', async () => {
    for (const date of WINDOW) {
      const [files, rows] = await Promise.all([
        buildContextDay(logDir, date, NOW, fileSource),
        buildContextDay(logDir, date, NOW, dbSource(db)),
      ]);
      expect(rows).toEqual(files);
    }
  });
});
