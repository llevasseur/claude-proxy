import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildSummaryScoped,
  buildUsageScoped,
  clearRawArchiveCache,
  rebuildNeeded,
  rebuildScope,
  sidecarDays,
  summaryDays,
  usageDays,
} from '../src/api.js';
import { fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * A debounce tick carries the reporting days its fs events touched, and a
 * builder whose payload reads none of them does nothing. Today keeps
 * recomputing; a change that cannot be placed on a day rebuilds everything.
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

/** Far enough back to sit outside every window either builder reads. */
const ANCIENT_DAY = '2025-01-01';

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

/** `fileSource`, counting every read either half of a day goes through. */
function countingSource() {
  const reads: string[] = [];
  return {
    reads,
    // `satisfies` keeps the object's inferred shape while still giving both overrides'
    // parameters `SidecarSource`'s own contextual types.
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
    } satisfies SidecarSource,
  };
}

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'scoped-stream-'));
  await writeSidecar(path.join(logDir, 'archive', CLOSED_DAY), CLOSED_ISO);
  await writeSidecar(path.join(logDir, 'archive', OPEN_DAY), TODAY_ARCHIVED_ISO);
  await writeSidecar(logDir, TODAY_LIVE_ISO);
  clearRawArchiveCache();
});

describe('mapping a changed file to its reporting days', () => {
  it('maps a sidecar name onto its UTC day and the day before, since REPORT_TZ is behind UTC', () => {
    // 21:00 EDT on 2026-08-02 is written under the 2026-08-03 UTC prefix.
    expect(sidecarDays(`${stemFor(TODAY_LIVE_ISO)}.audit.json`)).toEqual(new Set(['2026-08-02', '2026-08-03']));
    expect(sidecarDays(`${stemFor(TODAY_ARCHIVED_ISO)}.audit.json`)).toEqual(new Set(['2026-08-01', '2026-08-02']));
  });

  it('maps the other two files of the triple the same way', () => {
    const days = new Set(['2026-08-02', '2026-08-03']);
    expect(sidecarDays(`${stemFor(TODAY_LIVE_ISO)}.md`)).toEqual(days);
    expect(sidecarDays(`${stemFor(TODAY_LIVE_ISO)}.request.txt`)).toEqual(days);
  });

  it('refuses to place anything it cannot name a day for', () => {
    expect(sidecarDays(null)).toBeNull();
    expect(sidecarDays(undefined)).toBeNull();
    expect(sidecarDays('')).toBeNull();
    expect(sidecarDays('sessions/9f2c1ab4d5e60718.md')).toBeNull();
    expect(sidecarDays('archive/2026-08-01/digest.json')).toBeNull();
    expect(sidecarDays('suggestion-status.json')).toBeNull();
    expect(sidecarDays('concepts.jsonl')).toBeNull();
    expect(sidecarDays('.2026-08-03T01-00-00-000_anthropic.audit.json.swp')).toBeNull();
    expect(sidecarDays('notes.txt')).toBeNull();
  });
});

describe('one debounce tick’s scope', () => {
  it('carries every day the tick’s files touched, not just one', () => {
    const scope = rebuildScope([
      `${stemFor(CLOSED_ISO)}.audit.json`,
      `${stemFor(TODAY_LIVE_ISO)}.audit.json`,
      `${stemFor(TODAY_LIVE_ISO)}.request.txt`,
    ]);
    expect(scope).toEqual(new Set(['2026-07-31', '2026-08-01', '2026-08-02', '2026-08-03']));
  });

  it('falls back to a full rebuild when the watcher named no file at all', () => {
    expect(rebuildScope([null])).toBeNull();
    expect(rebuildScope([])).toBeNull();
  });

  it('taints the whole tick when any one file in it is out of band', () => {
    expect(rebuildScope([`${stemFor(TODAY_LIVE_ISO)}.audit.json`, 'sessions/9f2c1ab4d5e60718.md'])).toBeNull();
  });

  it('treats a null scope as “rebuild everything” rather than “rebuild nothing”', () => {
    expect(rebuildNeeded(null, [ANCIENT_DAY])).toBe(true);
    expect(rebuildNeeded(new Set([ANCIENT_DAY]), [ANCIENT_DAY])).toBe(true);
    expect(rebuildNeeded(new Set([ANCIENT_DAY]), [OPEN_DAY])).toBe(false);
  });
});

describe('the days each builder reads', () => {
  it('always covers today for an unpinned summary, so the day in progress recomputes', () => {
    expect(summaryDays(undefined, NOW).has(OPEN_DAY)).toBe(true);
    expect(usageDays(NOW).has(OPEN_DAY)).toBe(true);
  });

  it('covers the summary’s baseline walk, and stops there', () => {
    const days = summaryDays(undefined, NOW);
    expect(days.has(CLOSED_DAY)).toBe(true);
    expect(days.has('2026-07-19')).toBe(true); // 14 days back — the lookback floor
    expect(days.has('2026-07-18')).toBe(false);
    expect(days.has(ANCIENT_DAY)).toBe(false);
  });

  it('pins to the requested day when the summary carries ?date=', () => {
    expect(summaryDays(CLOSED_DAY, NOW).has(CLOSED_DAY)).toBe(true);
    expect(summaryDays(CLOSED_DAY, NOW).has(OPEN_DAY)).toBe(false);
  });
});

describe('the scoped rebuild', () => {
  it('recomputes today when a live capture lands, however late in the UTC day', async () => {
    const scope = rebuildScope([`${stemFor(TODAY_LIVE_ISO)}.audit.json`]);
    const first = await buildSummaryScoped(scope, logDir, undefined, NOW, undefined, fileSource);
    expect(first?.digest.date).toBe(OPEN_DAY);
    expect(first?.digest.requestCount).toBe(2);

    // A second capture on the day in progress moves the payload — the memo must
    // not have pinned it.
    await writeSidecar(logDir, '2026-08-03T02:30:00.000Z');
    const again = await buildSummaryScoped(
      rebuildScope([`${stemFor('2026-08-03T02:30:00.000Z')}.audit.json`]),
      logDir,
      undefined,
      NOW,
      undefined,
      fileSource,
    );
    expect(again?.digest.requestCount).toBe(3);
  });

  it('skips the rebuild entirely — and reads nothing — when the tick touched no day it covers', async () => {
    const { source, reads } = countingSource();
    const scope = rebuildScope([`${ANCIENT_DAY}T15-00-00-000_anthropic.audit.json`]);

    const summary = await buildSummaryScoped(scope, logDir, undefined, NOW, undefined, source);
    const usage = await buildUsageScoped(scope, logDir, WEEK, NOW, source);

    expect(summary).toBeNull();
    expect(usage).toBeNull();
    expect(reads).toEqual([]);
  });

  it('skips a summary pinned to a day the tick did not touch', async () => {
    const { source, reads } = countingSource();
    // A capture on the day in progress cannot move a summary pinned two weeks back.
    const scope = rebuildScope([`${stemFor(TODAY_LIVE_ISO)}.audit.json`]);

    expect(await buildSummaryScoped(scope, logDir, '2026-07-20', NOW, undefined, source)).toBeNull();
    expect(reads).toEqual([]);
  });

  it('rebuilds in full when the watcher could not name the file that changed', async () => {
    const summary = await buildSummaryScoped(null, logDir, undefined, NOW, undefined, fileSource);
    const usage = await buildUsageScoped(null, logDir, WEEK, NOW, fileSource);

    expect(summary?.digest.date).toBe(OPEN_DAY);
    expect(summary?.digest.requestCount).toBe(2);
    expect(usage?.usage.windows.length).toBeGreaterThan(0);
  });

  it('rebuilds in full when an out-of-band write shares the tick with a placeable one', async () => {
    const scope = rebuildScope([`${stemFor(TODAY_LIVE_ISO)}.audit.json`, 'suggestion-status.json']);
    expect(scope).toBeNull();
    // Pinned to a day the sidecar did not touch, so only the fallback can answer.
    expect(await buildSummaryScoped(scope, logDir, CLOSED_DAY, NOW, undefined, fileSource)).not.toBeNull();
  });

  it('answers a scoped rebuild exactly as the unscoped one would', async () => {
    const scoped = await buildSummaryScoped(
      rebuildScope([`${stemFor(TODAY_LIVE_ISO)}.audit.json`]),
      logDir,
      undefined,
      NOW,
      undefined,
      fileSource,
    );
    const full = await buildSummaryScoped(null, logDir, undefined, NOW, undefined, fileSource);
    expect(scoped).toEqual(full);
  });
});
