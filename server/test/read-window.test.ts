import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildContext, buildSkimTrend } from '../src/api.js';
import { fileSource } from '../src/db/source.js';
import { readSidecars } from '../src/logs.js';

/**
 * `readSidecars` scans one root. Every multi-day builder wants three: the live
 * directory, `<logDir>/archive/<date>/`, and — for a day whose raw triples were
 * relocated off the log volume — `<archiveDir>/<date>/raw/`. `readWindow` is the
 * one place that composition is written, so these pin it once and then confirm
 * two builders that used to stop at the live directory now see the whole window.
 */

/** 11:00 EDT — the reporting day and the UTC day agree. */
function morning(day: string): string {
  return `${day}T15:00:00.000Z`;
}

/**
 * 21:00 EDT on the day *before* `day`'s UTC date — the same reporting day as
 * `morning(prev)`, but filed in the next UTC archive folder.
 */
function evening(utcDay: string): string {
  return `${utcDay}T01:00:00.000Z`;
}

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
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stemFor(iso)}.audit.json`), JSON.stringify(body), 'utf8');
}

/** 14:00 EDT on the 4th, so `today()` is the 4th and it is still taking writes. */
const NOW = new Date('2026-08-04T18:00:00.000Z');

const LIVE = morning('2026-08-04');
/** Archived under `<logDir>/archive/`, in the two UTC folders the 2nd straddles. */
const ARCHIVED_MORNING = morning('2026-08-02');
const ARCHIVED_EVENING = evening('2026-08-03');
/** Relocated off the log volume entirely. */
const RELOCATED = morning('2026-08-01');

let logDir: string;
let archiveDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'read-window-logs-'));
  archiveDir = await mkdtemp(path.join(tmpdir(), 'read-window-archive-'));
  await writeSidecar(logDir, LIVE);
  await writeSidecar(path.join(logDir, 'archive', '2026-08-02'), ARCHIVED_MORNING);
  await writeSidecar(path.join(logDir, 'archive', '2026-08-03'), ARCHIVED_EVENING);
  await writeSidecar(path.join(archiveDir, '2026-08-01', 'raw'), RELOCATED);
});

function timestamps(sidecars: readonly unknown[]): string[] {
  return sidecars.map((s) => (s as { timestamp: string }).timestamp);
}

describe('readWindow over a window that spans the live dir and an archived day', () => {
  it('returns the archived day alongside the live one', async () => {
    const window = await fileSource.readWindow(logDir, { sinceDays: 4 }, NOW);

    expect(window.files).toBe(3);
    expect(window.parseErrors).toBe(0);
    expect(window.days.map((d) => d.date)).toEqual(['2026-08-02', '2026-08-04']);
    expect(window.days.map((d) => [d.archivedFiles, d.liveFiles])).toEqual([
      [2, 0],
      [0, 1],
    ]);
  });

  it('keeps the stream chronological — each day archived half first', async () => {
    const { sidecars } = await fileSource.readWindow(logDir, { sinceDays: 4 }, NOW);
    expect(timestamps(sidecars)).toEqual([ARCHIVED_MORNING, ARCHIVED_EVENING, LIVE]);
  });

  it('claims an evening request filed in the next UTC archive folder', async () => {
    const { days } = await fileSource.readWindow(logDir, { sinceDays: 4 }, NOW);
    const second = days.find((d) => d.date === '2026-08-02');
    expect(timestamps(second!.sidecars)).toEqual([ARCHIVED_MORNING, ARCHIVED_EVENING]);
    // …and it does not leak into the UTC day its filename carries.
    expect(days.some((d) => d.date === '2026-08-03')).toBe(false);
  });

  it('reaches a relocated day only when handed the archive root', async () => {
    const without = await fileSource.readWindow(logDir, { sinceDays: 4 }, NOW);
    expect(without.days.some((d) => d.date === '2026-08-01')).toBe(false);

    const withRoot = await fileSource.readWindow(logDir, { sinceDays: 4, archiveDir }, NOW);
    expect(withRoot.files).toBe(4);
    expect(withRoot.days.map((d) => d.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-04']);
    expect(timestamps(withRoot.sidecars)).toEqual([RELOCATED, ARCHIVED_MORNING, ARCHIVED_EVENING, LIVE]);
  });

  it('honours a `since` floor the same way, and stops above it', async () => {
    const { days } = await fileSource.readWindow(logDir, { since: '2026-08-03' }, NOW);
    expect(days.map((d) => d.date)).toEqual(['2026-08-04']);
  });

  it('reads a single day when given `date`', async () => {
    const { files, days } = await fileSource.readWindow(logDir, { date: '2026-08-02' }, NOW);
    expect(files).toBe(2);
    expect(days.map((d) => d.date)).toEqual(['2026-08-02']);
  });

  it('leaves `readSidecars` the single-root primitive it was', async () => {
    const { sidecars, files } = await readSidecars(logDir, { sinceDays: 4 }, NOW);
    expect(files).toBe(1);
    expect(timestamps(sidecars)).toEqual([LIVE]);
  });
});

describe('the builders behind the archived half', () => {
  it('counts an archived day in the context window', async () => {
    const { summary, meta } = await buildContext(logDir, 4, NOW);
    expect(meta.files).toBe(3);
    expect(summary.requestCount).toBe(3);
    expect(summary.entries.map((e) => e.timestamp)).toContain(ARCHIVED_MORNING);
  });

  it('gives the skim trend a bar for an archived day', async () => {
    const { digests, meta } = await buildSkimTrend(logDir, 4, NOW);
    expect(meta.files).toBe(3);
    expect(digests.map((d) => d.date)).toEqual(['2026-08-02', '2026-08-04']);
  });
});
