import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { buildContextDay, buildContextDayScoped, contextDayDays, rebuildScope } from '../src/api.js';
import { clearContextDayMemo } from '../src/context-day-memo.js';
import { fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * What `/api/context/day/stream` pushes, and what it declines to.
 *
 * The stream covers one reporting day, the narrowest scope any stream here has — so the
 * two edges are what matter: a capture on the open day moves the payload, and a capture on
 * any other day is not merely deduped but never read at all.
 */

/** 22:00 EDT on 2026-08-02, so that is the reporting day and it is still open. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const CLOSED_DAY = '2026-08-01';
/** Far enough back that no window the page composes reaches it. */
const ANCIENT_DAY = '2025-01-01';

/** 11:00 EDT on `day` — the UTC prefix matches the reporting day, and it has rotated out. */
function morning(day: string): string {
  return `${day}T15:00:00.000Z`;
}

/** 21:00 EDT on `day`, which is the *next* UTC day, so the file stays in the live root. */
function evening(day: string): string {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T01:00:00.000Z`;
}

function stemFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
}

/** The tick one captured request produces: its audit sidecar, named as the proxy names it. */
function tickFor(iso: string): string {
  return `${stemFor(iso)}.audit.json`;
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

/** `fileSource`, recording every read either half of a day — or the corpus floor — goes through. */
function countingSource() {
  const reads: string[] = [];
  return {
    reads,
    // `satisfies` keeps the inferred type while giving both overrides' parameters
    // `SidecarSource`'s contextual ones.
    source: {
      ...fileSource,
      readArchivedDay: (logDir, date, opts) => {
        reads.push(`archived:${date}`);
        return fileSource.readArchivedDay(logDir, date, opts);
      },
      readSidecars: (logDir, opts, now) => {
        reads.push(`live:${opts?.date ?? opts?.since ?? String(opts?.sinceDays)}`);
        return fileSource.readSidecars(logDir, opts, now);
      },
      oldestDay: (logDir, opts) => {
        reads.push('oldest');
        return fileSource.oldestDay(logDir, opts);
      },
    } satisfies SidecarSource,
  };
}

let logDir: string;

/** A closed day, plus the day in progress split across the archive and the live root. */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-day-stream-'));
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), morning(CLOSED_DAY), 22_000, 'bbbb');
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY), 44_000, 'dddd');
  await writeSidecar(logDir, evening(TODAY), 55_000, 'eeee');
  clearContextDayMemo();
});

afterEach(() => {
  clearContextDayMemo();
});

describe('the days one context day reads', () => {
  it('covers the day in progress when nothing is pinned, and only it', () => {
    const days = contextDayDays(undefined, NOW);
    expect([...days]).toEqual([TODAY]);
  });

  it('covers the named day when one is pinned, and not the day in progress', () => {
    const days = contextDayDays(CLOSED_DAY, NOW);
    expect(days.has(CLOSED_DAY)).toBe(true);
    expect(days.has(TODAY)).toBe(false);
  });
});

describe('the scoped rebuild behind the stream', () => {
  it('rebuilds on a capture that lands on the open day, however late in the UTC day', async () => {
    const first = await buildContextDayScoped(
      rebuildScope([tickFor(evening(TODAY))]),
      logDir,
      undefined,
      NOW,
      fileSource,
    );
    expect(first?.date).toBe(TODAY);
    expect(first?.aggregate.requestCount).toBe(2);

    // A second capture on the same day moves the payload — the open day is never memoized.
    const landed = '2026-08-03T02:30:00.000Z';
    await writeSidecar(logDir, landed, 66_000, 'ffff');
    const again = await buildContextDayScoped(rebuildScope([tickFor(landed)]), logDir, undefined, NOW, fileSource);
    expect(again?.aggregate.requestCount).toBe(3);
    // Which is what the reader sees move: the day's largest request follows the capture.
    expect(again?.aggregate.max?.realInput).toBe(66_000);
  });

  it('sends nothing — and reads nothing — for a capture on a day it does not cover', async () => {
    const { source, reads } = countingSource();
    const scope = rebuildScope([tickFor(morning(ANCIENT_DAY))]);

    expect(await buildContextDayScoped(scope, logDir, undefined, NOW, source)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('sends nothing for a capture on the open day when the response is pinned elsewhere', async () => {
    const { source, reads } = countingSource();
    expect(await buildContextDayScoped(rebuildScope([tickFor(evening(TODAY))]), logDir, CLOSED_DAY, NOW, source)).toBe(
      null,
    );
    expect(reads).toEqual([]);
  });

  it('rebuilds in full when the watcher could not name the file that changed', async () => {
    const day = await buildContextDayScoped(null, logDir, undefined, NOW, fileSource);
    expect(day?.date).toBe(TODAY);
    expect(day?.aggregate.requestCount).toBe(2);
  });

  it('rebuilds in full when an out-of-band write shares the tick with a placeable one', async () => {
    const scope = rebuildScope([tickFor(evening(TODAY)), 'suggestion-status.json']);
    expect(scope).toBeNull();
    expect(await buildContextDayScoped(scope, logDir, CLOSED_DAY, NOW, fileSource)).not.toBeNull();
  });

  it('answers a scoped rebuild exactly as the route it streams would', async () => {
    const scoped = await buildContextDayScoped(
      rebuildScope([tickFor(evening(TODAY))]),
      logDir,
      undefined,
      NOW,
      fileSource,
    );
    expect(scoped).toEqual(await buildContextDay(logDir, undefined, NOW, fileSource));
  });

  it('never vouches the day it streams as closed, so there is always something to follow', async () => {
    const day = await buildContextDayScoped(null, logDir, undefined, NOW, fileSource);
    expect(day?.closed).toBe(false);
    // And the floor the `All` window is composed from still rides on it.
    expect(day?.since).not.toBeNull();
  });
});
