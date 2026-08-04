import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { TrendEntry } from '@claude-proxy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSummary } from '../src/api.js';
import { readArchivedDay } from '../src/logs.js';

/**
 * A finished day leaves the log volume in two stages, and the summary has to
 * follow it through both. The raw triples are relocated to
 * `<archiveDir>/<date>/raw/` — so `<logDir>/archive/<date>/` is empty on a
 * deployment that relocates — and once retention prunes those, only
 * `<archiveDir>/<date>/digest.json` is left, kept indefinitely.
 *
 * Read neither and every prior day digests to `requestCount: 0`, the baseline
 * walk never finds a day that recorded anything, and every stat card reports no
 * earlier day while `/trends` — which already had the digest fallback — names
 * one.
 */

/** 11:00 EDT: the reporting day is the same as the UTC day. */
function morning(day: string): string {
  return `${day}T15:00:00.000Z`;
}

/** 21:00 EDT: the same reporting day, but the *next* UTC folder. */
function evening(day: string): string {
  return `${day}T01:00:00.000Z`;
}

const TOKENS = { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 };

async function writeSidecar(dir: string, iso: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const stem = `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
  const body = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: TOKENS,
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(body), 'utf8');
}

/** A finalized digest, in the shape the archived days on disk actually carry. */
async function writeDigest(archiveDir: string, day: string, requestCount: number): Promise<void> {
  await mkdir(path.join(archiveDir, day), { recursive: true });
  const digest = {
    date: day,
    requestCount,
    skipped: 0,
    models: {},
    tokens: {
      input: requestCount * 10,
      output: requestCount * 5,
      cacheRead: requestCount * 40,
      cacheCreation: 0,
      realInput: requestCount * 50,
      cacheHitRatio: 0.8,
    },
    cost: {
      input: requestCount,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
      total: requestCount * 0.5,
    },
    topTools: [],
    avgSystemPromptBytes: requestCount > 0 ? 1200 : 0,
    busiestHour: null,
  };
  await writeFile(path.join(archiveDir, day, 'digest.json'), JSON.stringify(digest), 'utf8');
}

/** 14:00 EDT on the 4th, so `today()` is that day and it is still open. */
const NOW = new Date('2026-08-04T18:00:00.000Z');
const TODAY = '2026-08-04';

let logDir: string;
let archiveDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'relocated-logs-'));
  archiveDir = await mkdtemp(path.join(tmpdir(), 'relocated-archive-'));
  // One request today, so the summary has a day to compare *from*.
  await writeSidecar(logDir, morning(TODAY));
});

function trendFor(trend: readonly TrendEntry[], field: string): TrendEntry {
  const entry = trend.find((t) => t.field === field);
  expect(entry, `no ${field} trend entry`).toBeDefined();
  return entry!;
}

describe('readArchivedDay on the relocated layout', () => {
  it('reads a day whose raw triples moved to <archiveDir>/<date>/raw/', async () => {
    await writeSidecar(path.join(archiveDir, '2026-08-02', 'raw'), morning('2026-08-02'));
    // The evening of the 2nd sits in the folder named for the 3rd.
    await writeSidecar(path.join(archiveDir, '2026-08-03', 'raw'), evening('2026-08-03'));

    const { sidecars, files } = await readArchivedDay(logDir, '2026-08-02', { archiveDir });

    expect(files).toBe(2);
    expect(sidecars).toHaveLength(2);
  });

  it('reports the day empty when the relocated root is not offered', async () => {
    await writeSidecar(path.join(archiveDir, '2026-08-02', 'raw'), morning('2026-08-02'));

    const { files } = await readArchivedDay(logDir, '2026-08-02');

    expect(files).toBe(0);
  });

  it('counts a folder once when both roots hold it, rather than doubling the day', async () => {
    const iso = morning('2026-08-02');
    await writeSidecar(path.join(logDir, 'archive', '2026-08-02'), iso);
    await writeSidecar(path.join(archiveDir, '2026-08-02', 'raw'), iso);

    const { files } = await readArchivedDay(logDir, '2026-08-02', { archiveDir });

    expect(files).toBe(1);
  });
});

describe('the summary baseline across a relocated archive', () => {
  it('resolves the baseline from relocated raw sidecars', async () => {
    await writeSidecar(path.join(archiveDir, '2026-08-03', 'raw'), morning('2026-08-03'));

    const { digest } = await buildSummary(logDir, TODAY, NOW, archiveDir);

    const requests = trendFor(digest.trend!, 'requestCount');
    expect(requests.priorDate).toBe('2026-08-03');
    expect(requests.prior).toBe(1);
    // Raw sidecars carry the whole digest, so a per-call field has a baseline too.
    expect(trendFor(digest.trend!, 'realInput').prior).toBe(TOKENS.realInput);
  });

  it('falls back to the finalized digest once retention has pruned the raw day', async () => {
    await writeDigest(archiveDir, '2026-08-03', 500);

    const { digest } = await buildSummary(logDir, TODAY, NOW, archiveDir);

    const requests = trendFor(digest.trend!, 'requestCount');
    expect(requests.priorDate).toBe('2026-08-03');
    expect(requests.prior).toBe(500);
    expect(trendFor(digest.trend!, 'cost').prior).toBe(250);
  });

  it('walks past days the archive records as genuinely idle', async () => {
    for (const day of ['2026-08-01', '2026-08-02', '2026-08-03']) await writeDigest(archiveDir, day, 0);
    await writeDigest(archiveDir, '2026-07-31', 771);

    const { digest } = await buildSummary(logDir, TODAY, NOW, archiveDir);

    const requests = trendFor(digest.trend!, 'requestCount');
    expect(requests.priorDate).toBe('2026-07-31');
    expect(requests.prior).toBe(771);
  });

  it('still reports no baseline when no earlier day recorded anything', async () => {
    for (const day of ['2026-08-01', '2026-08-02', '2026-08-03']) await writeDigest(archiveDir, day, 0);

    const { digest } = await buildSummary(logDir, TODAY, NOW, archiveDir);

    const requests = trendFor(digest.trend!, 'requestCount');
    expect(requests.priorDate).toBeUndefined();
    expect(requests.prior).toBe(0);
    expect(requests.deltaPct).toBe(0);
  });

  it('reports no baseline when the archive is not offered at all', async () => {
    await writeDigest(archiveDir, '2026-08-03', 500);

    const { digest } = await buildSummary(logDir, TODAY, NOW);

    expect(trendFor(digest.trend!, 'requestCount').priorDate).toBeUndefined();
  });
});
