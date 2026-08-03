import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearArchivedUsageCache,
  clearLearnedCeilingsCache,
  loadArchivedUsage,
  loadLearnedCeilings,
} from '../src/usage-history.js';

const NOW = new Date('2026-07-30T18:00:00.000Z');

/** A sidecar whose filename prefix is its UTC instant, exactly as the proxy writes it. */
function nameFor(iso: string): string {
  return `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic.audit.json`;
}

function body(iso: string, input: number) {
  return JSON.stringify({
    timestamp: iso,
    model: 'claude-sonnet-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input, output: 0, cacheRead: 0, cacheCreation: 0, realInput: 0 },
    request: { toolCount: 0, toolsBytes: 0, systemBytes: 0, totalBytes: 0 },
    tools: [],
  });
}

/** Write a sidecar into the archive day directory its instant belongs to. */
async function archive(logDir: string, iso: string, input: number): Promise<void> {
  const dir = path.join(logDir, 'archive', iso.slice(0, 10));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, nameFor(iso)), body(iso, input), 'utf8');
}

async function live(logDir: string, iso: string, input: number): Promise<void> {
  await writeFile(path.join(logDir, nameFor(iso)), body(iso, input), 'utf8');
}

const hoursBefore = (h: number): string => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'usage-history-'));
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
});

describe('loadLearnedCeilings', () => {
  it('reaches into the archive for the history the live directory cannot hold', async () => {
    // The live directory holds only today; a weekly ceiling exists solely because
    // the archive stretches back far enough to close a week.
    await archive(logDir, hoursBefore(24 * 25), 10);
    await archive(logDir, hoursBefore(24 * 20), 700);
    await archive(logDir, hoursBefore(24 * 9), 400);
    await live(logDir, hoursBefore(2), 50);

    const learned = await loadLearnedCeilings(logDir, NOW);
    expect(learned.week?.units).toBe(700);
  });

  it('learns nothing when only the live directory has anything in it', async () => {
    await live(logDir, hoursBefore(2), 50);
    expect(await loadLearnedCeilings(logDir, NOW)).toEqual({});
  });

  it('survives an archive directory that was never created', async () => {
    await live(logDir, hoursBefore(2), 50);
    await expect(loadLearnedCeilings(logDir, NOW)).resolves.toEqual({});
  });

  it('serves the memo rather than re-reading weeks of sidecars', async () => {
    await archive(logDir, hoursBefore(24 * 25), 10);
    await archive(logDir, hoursBefore(24 * 20), 700);
    expect((await loadLearnedCeilings(logDir, NOW)).week?.units).toBe(700);

    // More traffic lands on disk in that same week, but within the TTL the
    // cached answer stands.
    await archive(logDir, hoursBefore(24 * 19), 5000);
    expect((await loadLearnedCeilings(logDir, NOW)).week?.units).toBe(700);

    // Past the TTL it is recomputed, and the week now totals both requests.
    const later = new Date(NOW.getTime() + 2 * 3_600_000);
    expect((await loadLearnedCeilings(logDir, later)).week?.units).toBe(5700);
  });
});

describe('loadArchivedUsage', () => {
  it('returns the archived sidecars and the days they came from', async () => {
    await archive(logDir, hoursBefore(24 * 2), 100);
    await archive(logDir, hoursBefore(24 * 5), 200);

    const got = await loadArchivedUsage(logDir, NOW);
    expect(got.sidecars).toHaveLength(2);
    expect(got.retainedDays).toEqual(['2026-07-28', '2026-07-25']);
  });

  it('leaves a day with no directory out of the retained set', async () => {
    await archive(logDir, hoursBefore(24 * 2), 100);
    // The gap is the point: an unarchived day is a hole, not a quiet day.
    expect((await loadArchivedUsage(logDir, NOW)).retainedDays).not.toContain('2026-07-29');
  });

  it('survives an archive directory that was never created', async () => {
    await expect(loadArchivedUsage(logDir, NOW)).resolves.toEqual({
      sidecars: [],
      retainedDays: [],
      parseErrors: 0,
    });
  });

  it('serves a day it has already read from the memo', async () => {
    await archive(logDir, hoursBefore(24 * 2), 100);
    expect((await loadArchivedUsage(logDir, NOW)).sidecars).toHaveLength(1);

    // A finalized day does not change, so a second write to it is not re-read.
    await archive(logDir, hoursBefore(24 * 2 + 1), 100);
    expect((await loadArchivedUsage(logDir, NOW)).sidecars).toHaveLength(1);

    clearArchivedUsageCache();
    expect((await loadArchivedUsage(logDir, NOW)).sidecars).toHaveLength(2);
  });

  it('does not cache an absent day, so a later archive run is picked up', async () => {
    expect((await loadArchivedUsage(logDir, NOW)).retainedDays).toEqual([]);

    // The archive job runs late rather than never; the miss must not be sticky.
    await archive(logDir, hoursBefore(24 * 2), 100);
    expect((await loadArchivedUsage(logDir, NOW)).retainedDays).toEqual(['2026-07-28']);
  });
});
