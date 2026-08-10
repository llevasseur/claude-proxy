import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSummary, buildTrends, clearRawArchiveCache } from '../src/api.js';
import { fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * The archived read for a finished day happens exactly once across repeated
 * builds; the day still in progress is re-read every time.
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

/** `fileSource`, with a tally of which days its archived reads actually touched. */
function countingSource(): { source: SidecarSource; archivedReads: string[] } {
  const archivedReads: string[] = [];
  return {
    archivedReads,
    source: {
      ...fileSource,
      readArchivedDay: (logDir, date, opts) => {
        archivedReads.push(date);
        return fileSource.readArchivedDay(logDir, date, opts);
      },
    },
  };
}

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'day-digest-memo-'));
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), CLOSED_ISO);
  await writeSidecar(path.join(logDir, 'archive', OPEN_DAY), TODAY_ARCHIVED_ISO);
  await writeSidecar(logDir, TODAY_LIVE_ISO);
  clearRawArchiveCache();
});

describe('the closed-day digest memo', () => {
  it('reads a finished day from the archive once, however many times trends is built', async () => {
    const { source, archivedReads } = countingSource();
    const first = await buildTrends(logDir, 3, NOW, undefined, source);
    const second = await buildTrends(logDir, 3, NOW, undefined, source);

    expect(archivedReads.filter((d) => d === CLOSED_DAY)).toEqual([CLOSED_DAY]);
    expect(second.digests).toEqual(first.digests);
  });

  it('never caches the day in progress — it is re-read on every build', async () => {
    const { source, archivedReads } = countingSource();
    await buildTrends(logDir, 3, NOW, undefined, source);
    await buildTrends(logDir, 3, NOW, undefined, source);

    expect(archivedReads.filter((d) => d === OPEN_DAY)).toEqual([OPEN_DAY, OPEN_DAY]);
  });

  it('lets a later request on the open day change that day’s digest', async () => {
    const before = await buildTrends(logDir, 3, NOW, undefined, fileSource);
    const openBefore = before.digests.find((d) => d.date === OPEN_DAY);
    expect(openBefore?.requestCount).toBe(2);

    await writeSidecar(logDir, '2026-08-03T02:30:00.000Z');
    const after = await buildTrends(logDir, 3, NOW, undefined, fileSource);
    expect(after.digests.find((d) => d.date === OPEN_DAY)?.requestCount).toBe(3);
  });

  it('does not cache a day the archive has nothing for, so it can still arrive', async () => {
    const { source, archivedReads } = countingSource();
    await buildTrends(logDir, 4, NOW, undefined, source);
    await buildTrends(logDir, 4, NOW, undefined, source);

    // 2026-07-31 is in the window and on record nowhere: a miss, read both times.
    expect(archivedReads.filter((d) => d === '2026-07-31')).toHaveLength(2);
  });

  it('serves the summary baseline from the same memo the trends page filled', async () => {
    const { source, archivedReads } = countingSource();
    await buildTrends(logDir, 3, NOW, undefined, source);
    const reads = archivedReads.length;

    const summary = await buildSummary(logDir, OPEN_DAY, NOW, undefined, source);
    // The baseline walk stops at 2026-08-01, which trends already memoised.
    expect(archivedReads.slice(reads)).not.toContain(CLOSED_DAY);
    expect(summary.digest.date).toBe(OPEN_DAY);
  });

  it('keeps the baseline digests identical across a cold and a warm read', async () => {
    const cold = await buildSummary(logDir, OPEN_DAY, NOW, undefined, fileSource);
    const warm = await buildSummary(logDir, OPEN_DAY, NOW, undefined, fileSource);
    expect(warm.digest).toEqual(cold.digest);
    expect(warm.movement).toEqual(cold.movement);
  });
});
