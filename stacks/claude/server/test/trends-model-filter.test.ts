import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildTrends, clearRawArchiveCache } from '../src/api.js';
import { clearArchiveCache } from '../src/archive.js';
import { fileSource } from '../src/db/source.js';

/**
 * `/api/trends?models=` narrows a window to the traffic that went to one model. It
 * reads the raw sidecars, the only record carrying a model per request, so a day
 * left only as a finalized digest cannot be split and is reported as dropped.
 */

const OPUS = 'claude-opus-5';
const SONNET = 'claude-sonnet-5';

/** 11:00 EDT on the given reporting day, which is also that UTC day. */
const morning = (day: string) => `${day}T15:00:00.000Z`;
/** 14:00 EDT on the same reporting day. `REPORT_TZ` is behind UTC, so both
 * timestamps sit late enough in the UTC day to bucket onto it. */
const afternoon = (day: string) => `${day}T18:00:00.000Z`;

const TOKENS = { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 525 };

/** 22:00 EDT on the 2nd, so `today()` is the 2nd and it is still open. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const TODAY = '2026-08-02';
const ARCHIVED_DAY = '2026-08-01';
/** On record as a finalized digest alone — no raw triple survives it. */
const FINALIZED_DAY = '2026-07-31';

async function writeSidecar(dir: string, iso: string, model: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const stem = `${iso.replace(/:/g, '-').replace('.', '-').replace('Z', '')}_anthropic`;
  const body = {
    timestamp: iso,
    model,
    endpoint: 'POST /v1/messages',
    statusCode: 200,
    tokens: TOKENS,
    request: { toolCount: 1, toolsBytes: 900, systemBytes: 1200, totalBytes: 4000 },
    tools: [{ name: 'Bash', bytes: 900, estTokens: 225 }],
  };
  await writeFile(path.join(dir, `${stem}.audit.json`), JSON.stringify(body), 'utf8');
}

/** A finalized digest, in the shape the archived days on disk actually carry. */
async function writeDigest(archiveDir: string, day: string): Promise<void> {
  await mkdir(path.join(archiveDir, day), { recursive: true });
  const digest = {
    date: day,
    requestCount: 4,
    skipped: 0,
    models: { [OPUS]: 3, [SONNET]: 1 },
    tokens: { input: 40, output: 20, cacheRead: 160, cacheCreation: 0, realInput: 200, cacheHitRatio: 0.8 },
    cost: { input: 4, output: 0, cacheWrite: 0, cacheRead: 0, total: 2 },
    topTools: [],
    avgSystemPromptBytes: 1200,
    busiestHour: null,
  };
  await writeFile(path.join(archiveDir, day, 'digest.json'), JSON.stringify(digest), 'utf8');
}

let logDir: string;
let archiveDir: string;

/**
 * Two models on each of two raw days — one live, one archived — plus an older
 * day that only its finalized digest survives.
 */
beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'trends-model-filter-'));
  archiveDir = path.join(logDir, 'archive');
  await writeSidecar(logDir, morning(TODAY), OPUS);
  await writeSidecar(logDir, afternoon(TODAY), SONNET);
  await writeSidecar(path.join(archiveDir, ARCHIVED_DAY), morning(ARCHIVED_DAY), OPUS);
  await writeSidecar(path.join(archiveDir, ARCHIVED_DAY), afternoon(ARCHIVED_DAY), SONNET);
  await writeDigest(archiveDir, FINALIZED_DAY);
  clearRawArchiveCache();
  clearArchiveCache();
});

const trends = (models?: readonly string[]) => buildTrends(logDir, 7, NOW, archiveDir, fileSource, models);

describe('buildTrends under a model filter', () => {
  it('counts every model when no filter is given', async () => {
    const { digests, meta } = await trends();
    const today = digests.find((d) => d.date === TODAY);

    expect(today!.requestCount).toBe(2);
    expect(today!.tokens.input).toBe(TOKENS.input * 2);
    // Nothing was left out, so there is nothing for the page to report.
    expect(meta.unfilterableDays).toBe(0);
  });

  it('narrows each day to the requested model, tokens and spend included', async () => {
    const { digests } = await trends([OPUS]);
    const today = digests.find((d) => d.date === TODAY);
    const archived = digests.find((d) => d.date === ARCHIVED_DAY);

    expect(today!.requestCount).toBe(1);
    expect(today!.tokens.input).toBe(TOKENS.input);
    expect(Object.keys(today!.models)).toEqual([OPUS]);
    // The archived half of the window is filtered the same way as the live half.
    expect(archived!.requestCount).toBe(1);
    expect(Object.keys(archived!.models)).toEqual([OPUS]);
  });

  it('takes more than one model at once', async () => {
    const { digests } = await trends([OPUS, SONNET]);
    const today = digests.find((d) => d.date === TODAY);

    expect(today!.requestCount).toBe(2);
    expect(Object.keys(today!.models).sort()).toEqual([OPUS, SONNET]);
  });

  it('drops a day it can only read as a finalized digest, and says how many', async () => {
    const unfiltered = await trends();
    expect(unfiltered.digests.some((d) => d.date === FINALIZED_DAY)).toBe(true);

    const { digests, meta } = await trends([OPUS]);
    // Answering it unfiltered would put three models' tokens on one model's line.
    expect(digests.some((d) => d.date === FINALIZED_DAY)).toBe(false);
    expect(meta.unfilterableDays).toBe(1);
  });

  it('answers an unknown model with an empty window rather than the whole one', async () => {
    const { digests } = await trends(['claude-nonexistent']);
    expect(digests.every((d) => d.requestCount === 0)).toBe(true);
  });
});
