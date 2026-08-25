import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSummary } from '../src/api.js';
import { clearCorpusMemo, memoiseByCorpus } from '../src/corpus-memo.js';
import { ingest } from '../src/db/ingest.js';
import { openDb } from '../src/db/open.js';
import { dbSource, fileSource, type SidecarSource } from '../src/db/source.js';

/**
 * A builder whose corpus is provably unchanged answers from its previous
 * payload; a moved watermark, a different window or a failed build runs the
 * builder again.
 */

/** 22:00 EDT on 2026-08-02, so `today()` is that day and it is still open. */
const NOW = new Date('2026-08-03T02:00:00.000Z');
const OPEN_DAY = '2026-08-02';

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

/** `fileSource`, with a controllable watermark and a tally of its corpus reads. */
function stubSource(mark: () => string) {
  const reads: string[] = [];
  const source: SidecarSource = {
    ...fileSource,
    watermark: async () => mark(),
    readSidecars: (logDir, opts, now) => {
      reads.push(`live:${opts?.date ?? opts?.since ?? String(opts?.sinceDays)}`);
      return fileSource.readSidecars(logDir, opts, now);
    },
    readArchivedDay: (logDir, date, opts) => {
      reads.push(`archived:${date}`);
      return fileSource.readArchivedDay(logDir, date, opts);
    },
  };
  return { source, reads };
}

let logDir: string;
let mark: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'corpus-memo-'));
  await writeSidecar(logDir, '2026-08-03T01:00:00.000Z');
  mark = 'one';
  clearCorpusMemo();
});

describe('memoiseByCorpus', () => {
  it('answers an unchanged corpus from the previous payload without re-reading it', async () => {
    const { source, reads } = stubSource(() => mark);
    const first = await memoiseByCorpus('summary', logDir, source, OPEN_DAY, () =>
      buildSummary(logDir, OPEN_DAY, NOW, undefined, source),
    );
    expect(reads.length).toBeGreaterThan(0);
    const readsAfterFirst = reads.length;

    const second = await memoiseByCorpus('summary', logDir, source, OPEN_DAY, () =>
      buildSummary(logDir, OPEN_DAY, NOW, undefined, source),
    );
    expect(second).toEqual(first);
    expect(reads.length).toBe(readsAfterFirst);
  });

  it('runs the builder again once the watermark moves', async () => {
    const { source, reads } = stubSource(() => mark);
    await memoiseByCorpus('summary', logDir, source, OPEN_DAY, () =>
      buildSummary(logDir, OPEN_DAY, NOW, undefined, source),
    );
    const afterFirst = reads.length;
    mark = 'two';
    await memoiseByCorpus('summary', logDir, source, OPEN_DAY, () =>
      buildSummary(logDir, OPEN_DAY, NOW, undefined, source),
    );
    expect(reads.length).toBeGreaterThan(afterFirst);
  });

  it('keeps different vary strings apart over one watermark', async () => {
    const { source, reads } = stubSource(() => mark);
    await memoiseByCorpus('summary', logDir, source, OPEN_DAY, () =>
      buildSummary(logDir, OPEN_DAY, NOW, undefined, source),
    );
    const afterFirst = reads.length;
    await memoiseByCorpus('summary', logDir, source, '2026-08-01', () =>
      buildSummary(logDir, '2026-08-01', NOW, undefined, source),
    );
    expect(reads.length).toBeGreaterThan(afterFirst);
  });

  it('shares one in-flight build between concurrent callers', async () => {
    const { source } = stubSource(() => mark);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let builds = 0;
    const run = () =>
      memoiseByCorpus('summary', logDir, source, OPEN_DAY, async () => {
        builds += 1;
        await gate;
        return buildSummary(logDir, OPEN_DAY, NOW, undefined, source);
      });
    const first = run();
    const second = run();
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(builds).toBe(1);
    expect(b).toEqual(a);
  });

  it('drops a slot whose build failed, so the next call tries again', async () => {
    const { source } = stubSource(() => mark);
    let fail = true;
    const run = () =>
      memoiseByCorpus('summary', logDir, source, OPEN_DAY, () => {
        if (fail) return Promise.reject(new Error('read failed'));
        return Promise.resolve({ ok: true });
      });
    await expect(run()).rejects.toThrow('read failed');
    fail = false;
    await expect(run()).resolves.toEqual({ ok: true });
  });

  it('bypasses the memo for a backing with no watermark', async () => {
    const { watermark: _stripped, ...bare } = fileSource;
    // SAFETY: the spread dropped only the optional `watermark`, so `bare` still
    // satisfies every required member of `SidecarSource`.
    const unbaked = bare as SidecarSource;
    let builds = 0;
    const run = () =>
      memoiseByCorpus('summary', logDir, unbaked, OPEN_DAY, async () => {
        builds += 1;
        return builds;
      });
    await run();
    await run();
    expect(builds).toBe(2);
  });
});

describe('the backings’ watermarks', () => {
  it('moves when a capture lands in the live directory', async () => {
    const before = await fileSource.watermark?.(logDir);
    expect(before).toBeTruthy();
    await writeSidecar(logDir, '2026-08-03T01:30:00.000Z');
    const after = await fileSource.watermark?.(logDir);
    expect(after).not.toEqual(before);
  });

  it('is stable across calls and moves when ingest appends rows', async () => {
    const db = openDb(logDir);
    try {
      const source = dbSource(db);
      const before = await source.watermark?.(logDir);
      expect(before).toBeTruthy();
      expect(await source.watermark?.(logDir)).toEqual(before);
      await ingest(db, logDir);
      const after = await source.watermark?.(logDir);
      expect(after).not.toEqual(before);
    } finally {
      db.close();
    }
  });
});
