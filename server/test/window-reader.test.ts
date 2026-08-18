// A multi-day window has two halves — the live log dir and `logs/archive/<date>/`
// — and every builder that composed them by hand got a different subset. These
// drive the builders that were reading only the live half, so the day `maintain`
// archived last night still shows up.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildContext, buildSkimTrend, buildWithheld } from '../src/api.js';
import { readWindow } from '../src/db/source.js';

/** 11:00 EDT — the reporting day matches the UTC day the file is named for. */
function morning(day: string): string {
  return `${day}T15:00:00.000Z`;
}

async function writeSidecar(dir: string, iso: string, realInput: number): Promise<void> {
  await mkdir(dir, { recursive: true });
  const stem = `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
  const body = {
    timestamp: iso,
    model: 'claude-opus-5',
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput },
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(body), 'utf8');
}

/** 14:00 EDT on the 4th, so today is open and the 2nd/3rd are archivable. */
const NOW = new Date('2026-08-04T18:00:00.000Z');
const TODAY = '2026-08-04';

let logDir: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'window-reader-'));
  // Today, still live.
  await writeSidecar(logDir, morning(TODAY), 1_000);
  // Two days `maintain` has already moved out of the live directory.
  await writeSidecar(path.join(logDir, 'archive', '2026-08-03'), morning('2026-08-03'), 90_000);
  await writeSidecar(path.join(logDir, 'archive', '2026-08-02'), morning('2026-08-02'), 50_000);
});

describe('readWindow', () => {
  it('composes the archived half with the live one, oldest first', async () => {
    const { sidecars, files, archivedDays, days } = await readWindow(logDir, { sinceDays: 7 }, NOW);

    expect(files).toBe(3);
    expect(archivedDays).toBe(2);
    expect(days).toHaveLength(7);
    // SAFETY: every sidecar in this window came from `writeSidecar` above, whose body
    // literal always carries a `timestamp` field — the source type is wider only because
    // it also covers on-disk shapes this test's fixtures never write.
    expect(sidecars.map((s) => (s as { timestamp: string }).timestamp)).toEqual([
      morning('2026-08-02'),
      morning('2026-08-03'),
      morning(TODAY),
    ]);
  });

  it('groups the window by reporting day, whichever half the day came from', async () => {
    const { byDay } = await readWindow(logDir, { sinceDays: 7 }, NOW);

    expect([...byDay.keys()].sort()).toEqual(['2026-08-02', '2026-08-03', TODAY]);
    expect(byDay.get('2026-08-02')).toHaveLength(1);
  });

  it('honours a window narrower than the archive it could have read', async () => {
    const { files, archivedDays } = await readWindow(logDir, { sinceDays: 2 }, NOW);

    expect(files).toBe(2);
    expect(archivedDays).toBe(1);
  });

  it('reads the live root only when the span has no floor, rather than guessing one', async () => {
    const { files, days, archivedDays } = await readWindow(logDir, {}, NOW);

    expect(days).toEqual([]);
    expect(archivedDays).toBe(0);
    expect(files).toBe(1);
  });
});

describe('the window builders', () => {
  it('gives the context tiles the archived days, not just today', async () => {
    const { summary, meta } = await buildContext(logDir, 7, NOW);

    expect(meta.files).toBe(3);
    expect(summary.requestCount).toBe(3);
    // The peak is on an archived day; reading the live half alone reports 1_000.
    expect(summary.maxRealInput).toBe(90_000);
  });

  it('gives the skim trend a digest per day in the window', async () => {
    const { digests, meta } = await buildSkimTrend(logDir, 7, NOW);

    expect(meta.files).toBe(3);
    expect(digests.map((d) => d.date)).toEqual(['2026-08-02', '2026-08-03', TODAY]);
  });

  it('verifies the withheld policy against the archived traffic too', async () => {
    const { meta } = await buildWithheld(logDir, 7, path.join(logDir, 'no-settings.json'), NOW);

    expect(meta.files).toBe(3);
  });
});
