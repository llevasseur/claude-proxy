// `/api/context` used to answer with every request in the window — 40862 rows and
// 29.6 megabytes for a month — and let the browser sort them. The order, the search
// and the slice are the route's now, so what has to hold is that a page is a page of
// the *whole* window's order, and that the tiles beside the table still describe the
// window rather than the page.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildContext, CONTEXT_PAGE_SIZE, contextPageQuery } from '../src/api.js';
import { fileSource } from '../src/db/source.js';

const NOW = new Date('2026-07-29T12:00:00.000Z');
const SESSION = '0f0b7a02-1f4a-4a1d-9d34-9f6b1c2d3e40';
/** Twelve threads so a page of five leaves a third, partial page behind it. */
const THREADS = 12;

let logDir: string;

const pageOf = (raw: Parameters<typeof contextPageQuery>[0] = {}) =>
  buildContext(logDir, 7, NOW, fileSource, contextPageQuery(raw));

/** The thread ids in the order this fixture makes them, oldest and smallest first. */
const ids = Array.from({ length: THREADS }, (_, i) => `bbbb0000bbbb${String(i + 1).padStart(4, '0')}`);

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'context-paging-'));
  for (const [i, threadId] of ids.entries()) {
    // Minute, size, system bytes and tool bytes all climb together, so one ordering
    // check per column is enough to tell asc from desc.
    const minute = String(i).padStart(2, '0');
    await writeFile(
      path.join(logDir, `2026-07-29T09-${minute}-00-000Z_anthropic.audit.json`),
      JSON.stringify({
        timestamp: `2026-07-29T09:${minute}:00.000Z`,
        model: i % 2 === 0 ? 'claude-opus-5' : 'claude-haiku-4',
        session: { sessionId: SESSION, threadId },
        tokens: { input: 10, output: 5, cacheRead: 0, cacheCreation: 0, realInput: 1000 * (i + 1) },
        request: { toolCount: 1, toolsBytes: 100 * (i + 1), systemBytes: 200 * (i + 1), totalBytes: 3000 },
        tools: [],
      }),
    );
  }
});

describe('the context route sorting and paging the table', () => {
  it('defaults to newest first, a full page at a time', async () => {
    const { page } = await pageOf();

    expect(page.sort).toBe('when');
    expect(page.dir).toBe('desc');
    expect(page.offset).toBe(0);
    expect(page.limit).toBe(CONTEXT_PAGE_SIZE);
    expect(page.total).toBe(THREADS);
    expect(page.rows.map((r) => r.threadId)).toEqual([...ids].reverse());
  });

  it('slices the window-wide order rather than sorting a page', async () => {
    const first = await pageOf({ sort: 'realInput', dir: 'desc', limit: 5 });
    const second = await pageOf({ sort: 'realInput', dir: 'desc', offset: 5, limit: 5 });
    const last = await pageOf({ sort: 'realInput', dir: 'desc', offset: 10, limit: 5 });

    expect(first.page.rows.map((r) => r.realInput)).toEqual([12000, 11000, 10000, 9000, 8000]);
    expect(second.page.rows.map((r) => r.realInput)).toEqual([7000, 6000, 5000, 4000, 3000]);
    // The tail is short rather than wrapped, and still knows the window's size.
    expect(last.page.rows.map((r) => r.realInput)).toEqual([2000, 1000]);
    expect(last.page.total).toBe(THREADS);
    expect(last.page.matched).toBe(THREADS);
  });

  it('reverses on direction, per column', async () => {
    const when = await pageOf({ sort: 'when', dir: 'asc', limit: 3 });
    const system = await pageOf({ sort: 'systemBytes', dir: 'asc', limit: 3 });
    const tools = await pageOf({ sort: 'toolsBytes', dir: 'desc', limit: 3 });
    const model = await pageOf({ sort: 'model', dir: 'asc', limit: 1 });

    expect(when.page.rows.map((r) => r.threadId)).toEqual(ids.slice(0, 3));
    expect(system.page.rows.map((r) => r.systemBytes)).toEqual([200, 400, 600]);
    expect(tools.page.rows.map((r) => r.toolsBytes)).toEqual([1200, 1100, 1000]);
    expect(model.page.rows[0]?.models).toEqual(['claude-haiku-4']);
  });

  it('falls back to the default page for an unreadable or out-of-range query', async () => {
    const { page } = await pageOf({ sort: 'nonsense', dir: 'sideways', offset: '-4', limit: '99999' });

    expect(page.sort).toBe('when');
    expect(page.dir).toBe('desc');
    expect(page.offset).toBe(0);
    // Clamped to the route's ceiling, so one request cannot ask for the corpus back.
    expect(page.limit).toBeLessThanOrEqual(500);
    expect(page.rows.length).toBe(THREADS);
  });

  it('keeps the summary over the whole window, whichever page is asked for', async () => {
    const whole = await pageOf();
    const tail = await pageOf({ sort: 'realInput', dir: 'asc', offset: 10, limit: 5 });

    expect(tail.summary).toEqual(whole.summary);
    expect(tail.summary.requestCount).toBe(THREADS);
    expect(tail.summary.maxRealInput).toBe(12000);
    expect(tail.summary.avgRealInput).toBe(6500);
    expect(tail.summary.medianRealInput).toBe(6500);
    // The list beside the table was always capped at ten, and still is.
    expect(tail.summary.top).toHaveLength(10);
  });

  it('answers one page of rows rather than every request in the window', async () => {
    const { page } = await pageOf({ limit: 2 });

    expect(page.rows).toHaveLength(2);
    // A row is the thread's own peak plus its count — never its list of requests.
    expect(Object.keys(page.rows[0] ?? {}).sort()).toEqual([
      'file',
      'firstTimestamp',
      'key',
      'lastTimestamp',
      'models',
      'prompt',
      'realInput',
      'requestCount',
      'systemBytes',
      'threadId',
      'toolsBytes',
    ]);
  });
});
