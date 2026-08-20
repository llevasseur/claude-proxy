import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '../../proxy/json.ts';
import { buildContextThread, buildContextThreadScoped, contextThreadDays, rebuildScope } from '../src/api.js';
import { fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * What `/api/context/thread/stream` pushes, and what it declines to.
 *
 * The stream follows one thread over one `?days=` window, and the two questions that
 * matter are the two the thread page turns on: a capture *of this thread* moves the
 * payload, and a capture that is not this thread's does not move it. The second one is
 * answered in two different places on purpose — a capture outside the window is ruled out
 * without reading anything, while a capture inside the window for another thread is read
 * and comes back byte-identical, which is what the SSE writer's dedupe drops.
 */

/** 22:00 EDT on 2026-08-02, so that is the reporting day and it is still open. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const YESTERDAY = '2026-08-01';
/** Far enough back that the window under test does not reach it. */
const ANCIENT_DAY = '2025-01-01';

/** The window the page asks for in these tests: today and the two days before it. */
const DAYS = 3;

/** The thread whose page is subscribed, and one that shares its days without being it. */
const MINE = 'a1b2c3d4e5f60718';
const THEIRS = 'ffffeeeeddddcccc';

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

/** `fileSource`, recording every read either half of a day goes through. */
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
      readRootPrompts: (logDir, threadIds) => {
        reads.push(`prompts:${threadIds.length}`);
        return fileSource.readRootPrompts(logDir, threadIds);
      },
    } satisfies SidecarSource,
  };
}

let logDir: string;

/** Two requests of the subscribed thread inside the window, one of another thread beside them. */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-thread-stream-'));
  await writeSidecar(path.join(logDir, 'archive', YESTERDAY), morning(YESTERDAY), 22_000, MINE);
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY), 44_000, MINE);
  await writeSidecar(path.join(logDir, 'archive', TODAY), morning(TODAY).replace('T15', 'T16'), 91_000, THEIRS);
});

describe('the days one thread page reads', () => {
  it('covers its whole window, since a thread is spread across it rather than pinned to a day', () => {
    expect([...contextThreadDays(DAYS, NOW)]).toEqual(['2026-07-31', YESTERDAY, TODAY]);
  });

  it('names one day for a one-day window, and never the empty set that would rule every tick out', () => {
    expect([...contextThreadDays(1, NOW)]).toEqual([TODAY]);
  });
});

describe('the scoped rebuild behind the stream', () => {
  it('rebuilds on a capture of this thread, and the payload follows it', async () => {
    const before = await buildContextThreadScoped(
      rebuildScope([tickFor(morning(TODAY))]),
      logDir,
      MINE,
      DAYS,
      NOW,
      fileSource,
    );
    expect(before?.entries).toHaveLength(2);

    // The request a running conversation just sent — the reader had to reload for this.
    const landed = evening(TODAY);
    await writeSidecar(logDir, landed, 66_000, MINE);
    const after = await buildContextThreadScoped(rebuildScope([tickFor(landed)]), logDir, MINE, DAYS, NOW, fileSource);
    expect(after?.entries).toHaveLength(3);
    expect(after?.entries.at(-1)?.realInput).toBe(66_000);
  });

  it('sends nothing — and reads nothing — for a capture outside the window it was asked for', async () => {
    const { source, reads } = countingSource();
    const scope = rebuildScope([tickFor(morning(ANCIENT_DAY))]);

    expect(await buildContextThreadScoped(scope, logDir, MINE, DAYS, NOW, source)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('pushes no frame for another thread captured on a day it does read, because the payload is unmoved', async () => {
    const scope = rebuildScope([tickFor(morning(TODAY))]);
    const before = await buildContextThreadScoped(scope, logDir, MINE, DAYS, NOW, fileSource);

    // A capture of a thread this page is not about. The day is in the window, so the scope
    // cannot rule it out — a file name carries a UTC timestamp and never a thread id.
    const landed = evening(TODAY);
    await writeSidecar(logDir, landed, 120_000, THEIRS);
    const after = await buildContextThreadScoped(rebuildScope([tickFor(landed)]), logDir, MINE, DAYS, NOW, fileSource);

    // Byte-identical, which is exactly the comparison `serveSse` makes before it writes.
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // And the read that established that saw only this thread's requests.
    expect(after?.entries.every((entry) => entry.threadId === MINE)).toBe(true);
  });

  it('answers a scoped rebuild exactly as the route it streams would', async () => {
    const scoped = await buildContextThreadScoped(
      rebuildScope([tickFor(morning(TODAY))]),
      logDir,
      MINE,
      DAYS,
      NOW,
      fileSource,
    );
    expect(scoped).toEqual(await buildContextThread(logDir, MINE, DAYS, NOW, fileSource));
  });

  it('rebuilds in full when the watcher could not name the file that changed', async () => {
    const thread = await buildContextThreadScoped(null, logDir, MINE, DAYS, NOW, fileSource);
    expect(thread?.threadId).toBe(MINE);
    expect(thread?.entries).toHaveLength(2);
  });

  it('answers an empty list rather than null for a thread the window holds nothing of', async () => {
    const thread = await buildContextThreadScoped(null, logDir, 'aaaabbbbccccdddd', DAYS, NOW, fileSource);
    expect(thread?.entries).toEqual([]);
  });
});
