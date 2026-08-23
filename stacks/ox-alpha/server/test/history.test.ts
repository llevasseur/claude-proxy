import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PaginatedHistoryRecords } from '@agent-proxy/ox-core';
import { afterEach, describe, expect, test } from 'vitest';
import { LiveUsageService } from '../src/service.ts';
import { config, sidecar, temporaryDirectory, writeSidecar } from './helpers.ts';

const services: LiveUsageService[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function start(
  now: Date,
  prepare?: (directory: string) => Promise<void>,
): Promise<{ service: LiveUsageService; origin: string; directory: string }> {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  await prepare?.(temporary.path);
  const service = new LiveUsageService(config(temporary.path), () => now);
  services.push(service);
  const address = await service.start();
  return { service, origin: `http://${address.host}:${address.port}`, directory: temporary.path };
}

interface HistoryResponse {
  readonly dataVersion: number;
  readonly total: number;
  readonly offset: number;
  readonly limit: number | null;
  readonly nextOffset: number | null;
  readonly records: ReadonlyArray<{ recordId: string; timestamp: string; model: string }>;
}

interface TrendsResponse {
  readonly dataVersion: number;
  readonly reportTimezone: string;
  readonly buckets: ReadonlyArray<{
    date: string;
    requestCount: number;
    startInclusive: string;
    endExclusive: string;
    totalTokens: number;
  }>;
  readonly endExclusive: string;
  readonly total: Readonly<{ requestCount: number; inputTokens: number; outputTokens: number }>;
}

const fetchJson = async <T>(url: string): Promise<T> => (await fetch(url).then((response) => response.json())) as T;

describe('history and trends API', () => {
  test('paginates newest-first with stable ordering across inserts', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const { origin, service, directory } = await start(now, async (dir) => {
      await writeSidecar(dir, 'old.audit.json', sidecar('old', '2026-08-17T12:00:00.000Z'));
      await writeSidecar(dir, 'mid.audit.json', sidecar('mid', '2026-08-18T12:00:00.000Z'));
      await writeSidecar(dir, 'new.audit.json', sidecar('new', '2026-08-19T12:00:00.000Z'));
    });

    const before = await fetchJson<HistoryResponse>(`${origin}/api/history?limit=2&offset=0`);
    expect(before.total).toBe(3);
    expect(before.records.map((record) => record.recordId)).toEqual(['new', 'mid']);
    expect(before.nextOffset).toBe(2);

    const secondPage = await fetchJson<HistoryResponse>(`${origin}/api/history?limit=2&offset=2`);
    expect(secondPage.records.map((record) => record.recordId)).toEqual(['old']);
    expect(secondPage.nextOffset).toBeNull();

    await writeFile(
      join(directory, 'inserted.audit.json'),
      JSON.stringify(sidecar('inserted', '2026-08-19T15:00:00.000Z')),
    );
    await service.reconcile();

    const after = await fetchJson<HistoryResponse>(`${origin}/api/history?limit=2&offset=1`);
    expect(after.total).toBe(4);
    expect(after.records.map((record) => record.recordId)).toEqual(['new', 'mid']);

    // recordId breaks timestamp ties deterministically. The directory watcher
    // may already hold an in-flight scan, so poll until both ties land.
    await writeSidecar(directory, 'tie-a.audit.json', sidecar('tie-a', '2026-08-19T15:00:00.000Z'));
    await writeSidecar(directory, 'tie-b.audit.json', sidecar('tie-b', '2026-08-19T15:00:00.000Z'));
    let ties = await fetchJson<HistoryResponse>(`${origin}/api/history`);
    for (let attempt = 0; attempt < 50 && ties.total !== 6; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await service.reconcile();
      ties = await fetchJson<HistoryResponse>(`${origin}/api/history`);
    }
    expect(ties.total).toBe(6);
    expect(ties.records.slice(1, 3).map((record) => record.recordId)).toEqual(['tie-a', 'tie-b']);
  });

  test('rejects invalid ranges and pagination with typed errors', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const { origin } = await start(now);

    for (const query of ['from=20260801', 'to=2026-13-01', 'from=2026-08-10&to=2026-08-01']) {
      const history = await fetch(`${origin}/api/history?${query}`);
      expect(history.status).toBe(400);
      expect(await history.json()).toEqual({ error: 'invalid_query' });
      const trends = await fetch(`${origin}/api/trends?${query}`);
      expect(trends.status).toBe(400);
      expect(await trends.json()).toEqual({ error: 'invalid_query' });
    }

    for (const query of ['limit=0', 'limit=201', 'offset=-1', 'limit=1.5']) {
      const history = await fetch(`${origin}/api/history?${query}`);
      expect(history.status).toBe(400);
      expect(await history.json()).toEqual({ error: 'invalid_query' });
    }
  });

  test('buckets trends by report-timezone calendar dates across a DST boundary', async () => {
    const now = new Date('2026-03-09T16:00:00.000Z');
    const { origin } = await start(now, async (dir) => {
      // America/New_York springs forward on 2026-03-08: a 23-hour day whose
      // window runs 05:00Z -> 04:00Z the next day.
      await writeSidecar(dir, 'pre.audit.json', sidecar('pre', '2026-03-07T20:00:00.000Z'));
      await writeSidecar(dir, 'edge.audit.json', sidecar('edge', '2026-03-08T04:59:59.000Z'));
      await writeSidecar(dir, 'dst.audit.json', sidecar('dst', '2026-03-08T05:00:00.000Z'));
      await writeSidecar(dir, 'post.audit.json', sidecar('post', '2026-03-09T10:00:00.000Z'));
    });
    const trends = await fetchJson<TrendsResponse>(`${origin}/api/trends?from=2026-03-07&to=2026-03-09`);
    expect(trends.reportTimezone).toBe('America/New_York');
    expect(trends.buckets.map((bucket) => bucket.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    const [pre, dst, post] = trends.buckets;
    if (!pre || !dst || !post) throw new Error('expected three buckets');
    expect(dst).toMatchObject({
      startInclusive: '2026-03-08T05:00:00.000Z',
      endExclusive: '2026-03-09T04:00:00.000Z',
      requestCount: 1,
      totalTokens: 14,
    });
    expect(pre.requestCount).toBe(2);
    expect(post.requestCount).toBe(1);
    expect(trends.total.requestCount).toBe(4);

    // Omitted bounds mean all durable history up to today in REPORT_TZ.
    const openEnded = await fetchJson<TrendsResponse>(`${origin}/api/trends`);
    expect(openEnded.endExclusive).toBe('2026-03-10T04:00:00.000Z');
    expect(openEnded.total.requestCount).toBe(4);
  });

  test('applies exact multi-select model filters to both endpoints', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const { origin } = await start(now, async (dir) => {
      await writeSidecar(dir, 'a.audit.json', sidecar('a', undefined, { model: 'gpt-5' }));
      await writeSidecar(dir, 'b.audit.json', sidecar('b', '2026-08-18T12:00:00.000Z', { model: 'claude-x' }));
      await writeSidecar(dir, 'c.audit.json', sidecar('c', '2026-08-17T12:00:00.000Z'));
    });

    const oneModel = await fetchJson<HistoryResponse>(`${origin}/api/history?model=gpt-5`);
    expect(oneModel.records.map((record) => record.recordId)).toEqual(['a', 'c']);
    const twoModels = await fetchJson<HistoryResponse>(`${origin}/api/history?model=gpt-5&model=claude-x`);
    expect(twoModels.total).toBe(3);
    const caseSensitive = await fetchJson<HistoryResponse>(`${origin}/api/history?model=GPT-5`);
    expect(caseSensitive.total).toBe(0);
    const unknown = await fetchJson<HistoryResponse>(`${origin}/api/history?model=future-model`);
    expect(unknown.total).toBe(0);

    const trendFilter = await fetchJson<TrendsResponse>(`${origin}/api/trends?model=claude-x`);
    expect(trendFilter.total.requestCount).toBe(1);
  });

  test('advances the SSE data-version monotonically as ingest changes history', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const now = new Date('2026-08-19T18:00:00.000Z');
    const service = new LiveUsageService(config(temporary.path), () => now);
    services.push(service);
    const address = await service.start();
    const origin = `http://${address.host}:${address.port}`;

    const initial = await fetchJson<HistoryResponse>(`${origin}/api/history`);
    expect(initial.dataVersion).toBe(0);

    const response = await fetch(`${origin}/api/events`);
    const body = response.body;
    if (!body) throw new Error('missing SSE body');
    const reader = body.getReader();
    let buffer = '';
    const readUntilFrame = async (eventName: string): Promise<string> => {
      const marker = `event: ${eventName}`;
      while (!(buffer.includes(marker) && buffer.includes('\n\n', buffer.indexOf(marker)))) {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error('timed out waiting for SSE')), 500),
          ),
        ]);
        buffer += new TextDecoder().decode(result.value);
      }
      const end = buffer.indexOf('\n\n', buffer.indexOf(marker)) + 2;
      const consumed = buffer.slice(0, end);
      buffer = buffer.slice(end);
      return consumed;
    };
    await readUntilFrame('snapshot');

    await writeSidecar(temporary.path, 'live.audit.json', sidecar('live'));
    await service.reconcile();
    const firstSignal = await readUntilFrame('data-version');
    const firstVersion = Number(firstSignal.match(/"dataVersion":(\d+)/)?.[1]);
    expect(firstVersion).toBeGreaterThan(initial.dataVersion);
    expect(firstSignal).not.toContain('"requestCount"');

    // A no-op reconcile must not emit a signal; backfilling an old record must.
    await service.reconcile();
    await writeSidecar(temporary.path, 'backfill.audit.json', sidecar('backfill', '2026-08-01T12:00:00.000Z'));
    await service.reconcile();
    const secondSignal = await readUntilFrame('data-version');
    const secondVersion = Number(secondSignal.match(/"dataVersion":(\d+)/)?.[1]);
    expect(secondVersion).toBeGreaterThan(firstVersion);

    const latest = await fetchJson<HistoryResponse>(`${origin}/api/history`);
    expect(latest.dataVersion).toBe(secondVersion);
    const latestTrends = await fetchJson<TrendsResponse>(`${origin}/api/trends`);
    expect(latestTrends.dataVersion).toBe(secondVersion);
    await reader.cancel();
  });

  test('serves identical history and trends after a full database rebuild', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const first = await start(now, async (dir) => {
      await writeSidecar(dir, 'one.audit.json', sidecar('one'));
      await writeSidecar(dir, 'two.audit.json', sidecar('two', '2026-08-01T12:00:00.000Z', { unavailable: true }));
    });
    const historyBefore = await fetchJson<PaginatedHistoryRecords & HistoryResponse>(`${first.origin}/api/history`);
    const trendsBefore = await fetchJson<TrendsResponse>(`${first.origin}/api/trends`);
    await services.pop()?.close();

    await rm(join(first.directory, 'usage.db'), { force: true });
    await rm(join(first.directory, 'usage.db-wal'), { force: true });
    await rm(join(first.directory, 'usage.db-shm'), { force: true });

    const reopened = new LiveUsageService(config(first.directory), () => now);
    services.push(reopened);
    const address = await reopened.start();
    const origin = `http://${address.host}:${address.port}`;
    expect(await fetchJson<unknown>(`${origin}/api/history`)).toEqual(historyBefore);
    expect(await fetchJson<unknown>(`${origin}/api/trends`)).toEqual(trendsBefore);
    expect(historyBefore.total).toBe(2);
    expect(historyBefore.records.some((record) => record.cost === null)).toBe(true);
  });
});
