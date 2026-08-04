import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPromptMix, buildSummary, buildTools, buildTrends, clearRawArchiveCache } from '../src/api.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource } from '../src/db/source.js';

/**
 * A reporting day is a `REPORT_TZ` (America/New_York) day, but the summary job
 * rotates `logs/` into `archive/<date>/` on the *UTC* day. The two boundaries
 * are four hours apart, so the newest day or two is split: its morning is
 * already archived while its evening is still live. These tests pin that such
 * a day is read from both halves.
 */

/** 11:00 EDT on the reporting day: already rotated into `archive/2026-08-02/`. */
const ARCHIVED_ISO = '2026-08-02T15:00:00.000Z';
/** 21:00 EDT the *same* reporting day, but the next UTC day — so still live. */
const LIVE_ISO = '2026-08-03T01:00:00.000Z';
/** A day that rotated out whole, with no live remainder. */
const WHOLE_ISO = '2026-08-01T15:00:00.000Z';

const SPLIT_DAY = '2026-08-02';
const WHOLE_DAY = '2026-08-01';

/** 22:00 EDT on the split day, so `today()` is that day and it is still open. */
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

let logDir: string;
let db: DatabaseSync;

/**
 * One split reporting day — one request archived, one still live — plus a day
 * that rotated out whole.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'trends-split-day-'));
  await writeSidecar(path.join(logDir, 'archive', SPLIT_DAY), ARCHIVED_ISO);
  await writeSidecar(path.join(logDir, 'archive', WHOLE_DAY), WHOLE_ISO);
  await writeSidecar(logDir, LIVE_ISO);
  clearRawArchiveCache();
  db = openDb(logDir);
  await ingest(db, logDir);
});

afterEach(() => {
  db?.close();
});

const BACKINGS = [
  { name: 'files', make: () => fileSource },
  { name: 'db', make: () => dbSource(db) },
];

describe('a reporting day split across the live dir and the archive', () => {
  for (const backing of BACKINGS) {
    it(`digests both halves as one day, from ${backing.name}`, async () => {
      const { digests } = await buildTrends(logDir, 7, NOW, undefined, backing.make());
      const split = digests.find((d) => d.date === SPLIT_DAY);

      expect(split, 'the split day should be in the window').toBeDefined();
      expect(split!.requestCount).toBe(2);
      expect(split!.tokens.input).toBe(TOKENS.input * 2);
      expect(split!.tokens.output).toBe(TOKENS.output * 2);
      expect(split!.tokens.cacheRead).toBe(TOKENS.cacheRead * 2);
      expect(split!.tokens.cacheCreation).toBe(TOKENS.cacheCreation * 2);
      expect(split!.cost.total).toBeGreaterThan(0);
    });

    it(`leaves a fully-archived day alone, from ${backing.name}`, async () => {
      const { digests, meta } = await buildTrends(logDir, 7, NOW, undefined, backing.make());
      const whole = digests.find((d) => d.date === WHOLE_DAY);

      expect(whole!.requestCount).toBe(1);
      expect(whole!.tokens.input).toBe(TOKENS.input);
      // Both days read from the archive, the split one alongside its live half.
      expect(meta.archivedDays).toBe(2);
    });

    it(`counts both halves in the prompt-mix window, from ${backing.name}`, async () => {
      const { days } = await buildPromptMix(logDir, 7, NOW, backing.make());
      const split = days.find((d) => d.date === SPLIT_DAY);

      expect(split, 'the split day should be in the window').toBeDefined();
      expect(split!.requests).toBe(2);
      expect(days.find((d) => d.date === WHOLE_DAY)!.requests).toBe(1);
    });

    it(`digests both halves for the day summary, from ${backing.name}`, async () => {
      const { digest, meta } = await buildSummary(logDir, SPLIT_DAY, NOW, undefined, backing.make());

      expect(digest.requestCount).toBe(2);
      expect(digest.tokens.input).toBe(TOKENS.input * 2);
      expect(meta.files).toBe(2);
    });

    it(`summarizes a fully-archived day rather than reporting it empty, from ${backing.name}`, async () => {
      const { digest, meta } = await buildSummary(logDir, WHOLE_DAY, NOW, undefined, backing.make());

      expect(digest.requestCount).toBe(1);
      expect(digest.tokens.input).toBe(TOKENS.input);
      expect(meta.files).toBe(1);
    });

    it(`trends the summary against the archived day before it, from ${backing.name}`, async () => {
      const { digest } = await buildSummary(logDir, SPLIT_DAY, NOW, undefined, backing.make());
      expect(digest.trend).toBeDefined();
      expect(digest.trend!.length).toBeGreaterThan(0);
    });

    it(`counts both halves in the day's tool table, from ${backing.name}`, async () => {
      const { topTools, meta } = await buildTools(logDir, SPLIT_DAY, NOW, undefined, backing.make());

      expect(meta.files).toBe(2);
      // 900 bytes of Bash schema on each half of the day.
      expect(topTools.find((t) => t.name === 'Bash')!.totalBytes).toBe(1800);
    });
  }

  it('answers identically through either backing', async () => {
    const fromFiles = await buildTrends(logDir, 7, NOW, undefined, fileSource);
    clearRawArchiveCache();
    const fromDb = await buildTrends(logDir, 7, NOW, undefined, dbSource(db));
    expect(JSON.stringify(fromDb)).toBe(JSON.stringify(fromFiles));
  });

  it('chains the split day against the archived day before it', async () => {
    const { digests } = await buildTrends(logDir, 7, NOW, undefined, fileSource);
    const split = digests.find((d) => d.date === SPLIT_DAY);
    // The day before is fully archived; the split day still trends against it.
    expect(split!.trend).toBeDefined();
    expect(split!.trend!.length).toBeGreaterThan(0);
  });
});
