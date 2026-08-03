import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { UsageWindowMeter } from '@claude-proxy/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildUsage } from '../src/api.js';
import { clearArchivedUsageCache, clearLearnedCeilingsCache } from '../src/usage-history.js';

/** 14:00 EDT on 2026-07-30, so the weekly window opens mid-afternoon on the 23rd. */
const NOW = new Date('2026-07-30T18:00:00.000Z');

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

async function archive(logDir: string, iso: string, input: number): Promise<void> {
  const dir = path.join(logDir, 'archive', iso.slice(0, 10));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, nameFor(iso)), body(iso, input), 'utf8');
}

async function live(logDir: string, iso: string, input: number): Promise<void> {
  await writeFile(path.join(logDir, nameFor(iso)), body(iso, input), 'utf8');
}

const daysBefore = (d: number): string => new Date(NOW.getTime() - d * 24 * 3_600_000).toISOString();

const WEEK = { week: 10_000 };

const only = (windows: UsageWindowMeter[], kind: string): UsageWindowMeter => {
  const w = windows.find((x) => x.kind === kind);
  if (!w) throw new Error(`no ${kind} window in [${windows.map((x) => x.kind).join(', ')}]`);
  return w;
};

/** The whole weekly window on disk: today live, the seven days behind it archived. */
async function fullWeek(logDir: string, skip: number[] = []): Promise<void> {
  await live(logDir, daysBefore(0), 50);
  for (let d = 1; d <= 7; d += 1) {
    if (skip.includes(d)) continue;
    await archive(logDir, daysBefore(d), 100);
  }
}

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'usage-backfill-'));
  clearLearnedCeilingsCache();
  clearArchivedUsageCache();
});

describe('buildUsage — archived backfill', () => {
  it('counts archived requests, not just the live directory', async () => {
    await fullWeek(logDir);

    const { usage } = await buildUsage(logDir, WEEK, NOW);
    const w = only(usage.windows, 'week');
    // 7 archived days at 100 plus today's 50 — the live directory alone knows of 50.
    expect(w.usedUnits).toBe(750);
    expect(w.coverage).toBe(1);
    expect(w.pace.blurb).not.toMatch(/still on disk/);
  });

  it('reads as a sliver of the week when only the live day is on disk', async () => {
    // The bug this feature exists to fix: a week measured from a few hours of logs.
    await live(logDir, daysBefore(0), 50);

    const w = only((await buildUsage(logDir, WEEK, NOW)).usage.windows, 'week');
    expect(w.usedUnits).toBe(50);
    expect(w.coverage).toBeCloseTo(14 / 168, 3); // midnight to 14:00 of one day
    expect(w.pace.blurb).toMatch(/still on disk, so the real figure is higher/);
  });

  it('marks a window whose middle days were never archived', async () => {
    await fullWeek(logDir, [3, 4]);

    const w = only((await buildUsage(logDir, WEEK, NOW)).usage.windows, 'week');
    expect(w.usedUnits).toBe(550); // five archived days plus today
    expect(w.coverage).toBeCloseTo(5 / 7, 2);
    expect(w.pace.blurb).toMatch(/still on disk, so the real figure is higher/);
  });

  it('counts a request once when it is both live and archived', async () => {
    await live(logDir, daysBefore(0), 50);
    // A copy-based archiver leaves the same file in both places.
    await live(logDir, daysBefore(1), 100);
    await archive(logDir, daysBefore(1), 100);

    const w = only((await buildUsage(logDir, WEEK, NOW)).usage.windows, 'week');
    expect(w.usedUnits).toBe(150);
  });
});
