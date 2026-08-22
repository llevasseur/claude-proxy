import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { UsageDatabase } from '../src/database.ts';
import { LiveUsageService } from '../src/service.ts';
import { config, sidecar, temporaryDirectory, writeSidecar } from './helpers.ts';

const runtimeRequire = createRequire(import.meta.url);
const { DatabaseSync } = runtimeRequire('node:sqlite') as typeof import('node:sqlite');

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
  readonly limit: number;
  readonly offset: number;
  readonly records: ReadonlyArray<{
    readonly recordId: string;
    readonly timestamp: string;
    readonly model: string;
    readonly endpoint: string;
    readonly responseStatus: number;
    readonly requestId: string | null;
    readonly inputTokens: number;
    readonly totalTokens: number;
    readonly cost: Readonly<{ amountUsd: string }> | null;
    readonly costUnavailableReason: Readonly<{ code: string }> | null;
  }>;
}

interface TrendsResponse {
  readonly dataVersion: number;
  readonly reportTimezone: string;
  readonly buckets: ReadonlyArray<{
    readonly date: string;
    readonly startInclusive: string;
    readonly endExclusive: string;
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly cost: Readonly<{ amountUsd: string }> | null;
    readonly costUnavailableReason: Readonly<{ code: string }> | null;
  }>;
  readonly total: Readonly<{
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly cost: Readonly<{ amountUsd: string }> | null;
    readonly costUnavailableReason: Readonly<{ code: string }> | null;
  }>;
}

describe('Car view schema v2', () => {
  test('rebuilds a mismatched database empty and reproduces seeded results by re-ingesting', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const path = join(temporary.path, 'usage.db');
    const range = { reportTimezone: 'UTC', startInclusive: null, endExclusive: new Date('2026-08-20T00:00:00Z') };
    const first = new UsageDatabase(path);
    first.ingest('a.audit.json', sidecar('a'), new Date());
    first.ingest('b.audit.json', sidecar('b'), new Date());
    const seeded = first.history(range, [], 50, 0);
    first.close();

    const corruptor = new DatabaseSync(path);
    corruptor.exec('PRAGMA user_version = 3');
    corruptor.close();

    const second = new UsageDatabase(path);
    expect(second.schemaVersion).toBe(2);
    expect(second.diagnostics().recordCount).toBe(0);
    second.ingest('a.audit.json', sidecar('a'), new Date());
    second.ingest('b.audit.json', sidecar('b'), new Date());
    expect(second.history(range, [], 50, 0)).toEqual(seeded);
    second.close();
  });

  test('startup backfill re-ingests every final sidecar after discarding a legacy v1 database', async () => {
    const { origin } = await start(new Date('2026-08-19T18:00:00.000Z'), async (directory) => {
      mkdirSync(directory, { recursive: true });
      const legacy = new DatabaseSync(join(directory, 'usage.db'));
      legacy.exec(`
        CREATE TABLE usage_records (
          record_id TEXT PRIMARY KEY,
          filename TEXT NOT NULL UNIQUE,
          event_timestamp TEXT NOT NULL,
          sidecar_json TEXT NOT NULL
        );
        CREATE TABLE ingest_watermarks (
          filename TEXT PRIMARY KEY,
          record_id TEXT NOT NULL,
          ingested_at TEXT NOT NULL
        );
        CREATE TABLE rejected_sidecars (
          filename TEXT PRIMARY KEY,
          reason TEXT NOT NULL,
          rejected_at TEXT NOT NULL
        );
        PRAGMA user_version = 1;
      `);
      legacy.close();
      await writeSidecar(directory, 'one.audit.json', sidecar('one'));
      await writeSidecar(directory, 'two.audit.json', sidecar('two', '2026-08-18T16:00:00.000Z'));
    });
    const health = (await fetch(`${origin}/api/health`).then((response) => response.json())) as {
      database: { schemaVersion: number; journalMode: string; recordCount: number };
    };
    expect(health.database).toMatchObject({ schemaVersion: 2, journalMode: 'wal', recordCount: 2 });

    const history = (await fetch(`${origin}/api/history`).then((response) => response.json())) as HistoryResponse;
    expect(history.total).toBe(2);
    expect(history.records.map((record) => record.recordId)).toEqual(['one', 'two']);
    const repeat = await fetch(`${origin}/api/history`).then((response) => response.json());
    expect(repeat).toEqual(history);
  });
});

describe('Car history API', () => {
  test('lists sanitized records newest first with deterministic pagination', async () => {
    const { origin } = await start(new Date('2026-08-19T18:00:00.000Z'), async (directory) => {
      const letters = ['a', 'b', 'c', 'd', 'e'];
      for (const [index, letter] of letters.entries()) {
        await writeSidecar(directory, `${letter}.audit.json`, sidecar(letter, `2026-08-1${index + 1}T12:00:00.000Z`));
      }
    });
    const fetchHistory = async (query = ''): Promise<HistoryResponse> =>
      (await fetch(`${origin}/api/history${query}`).then((response) => response.json())) as HistoryResponse;

    const full = await fetchHistory();
    expect(full.total).toBe(5);
    expect(full.records.map((record) => record.recordId)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(full.records[0]).toMatchObject({
      model: 'gpt-5',
      endpoint: '/v1/responses',
      responseStatus: 200,
      requestId: 'request-e',
      inputTokens: 10,
      totalTokens: 14,
      cost: { amountUsd: '0.000053' },
      costUnavailableReason: null,
    });

    const pages: string[][] = [];
    for (const offset of [0, 2, 4]) {
      const page = await fetchHistory(`?limit=2&offset=${offset}`);
      expect(page.limit).toBe(2);
      expect(page.offset).toBe(offset);
      pages.push(page.records.map((record) => record.recordId));
    }
    expect(pages.flat()).toEqual(full.records.map((record) => record.recordId));
    const tail = await fetchHistory('?limit=2&offset=4');
    expect(tail.records).toHaveLength(1);

    const unavailableOrigin = (
      await start(new Date('2026-08-19T18:00:00.000Z'), async (directory) => {
        await writeSidecar(directory, 'u.audit.json', sidecar('u', undefined, { unavailable: true }));
      })
    ).origin;
    const unavailablePage = (await fetch(`${unavailableOrigin}/api/history`).then((response) =>
      response.json(),
    )) as HistoryResponse;
    expect(unavailablePage.records[0]).toMatchObject({
      cost: null,
      costUnavailableReason: { code: 'unknown-model' },
    });
  });

  test('resolves DST-spanning calendar ranges through the report timezone', async () => {
    const { origin } = await start(new Date('2026-03-09T12:00:00.000Z'), async (directory) => {
      await writeSidecar(directory, 'sat.audit.json', sidecar('sat', '2026-03-07T15:00:00.000Z'));
      await writeSidecar(directory, 'spring.audit.json', sidecar('spring', '2026-03-08T06:30:00.000Z'));
      await writeSidecar(directory, 'mon.audit.json', sidecar('mon', '2026-03-09T04:30:00.000Z'));
    });
    const trends = (await fetch(`${origin}/api/trends?from=2026-03-07&to=2026-03-09`).then((response) =>
      response.json(),
    )) as TrendsResponse;
    expect(trends.reportTimezone).toBe('America/New_York');
    expect(trends.buckets.map((bucket) => bucket.date)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
    expect(trends.buckets[1]).toMatchObject({
      startInclusive: '2026-03-08T05:00:00.000Z',
      endExclusive: '2026-03-09T04:00:00.000Z',
      requestCount: 1,
    });
    expect(trends.buckets.map((bucket) => bucket.requestCount)).toEqual([1, 1, 1]);
    expect(trends.buckets.map((bucket) => bucket.cost?.amountUsd ?? null)).toEqual([
      '0.000053',
      '0.000053',
      '0.000053',
    ]);
    expect(trends.total).toMatchObject({ requestCount: 3, totalTokens: 42, cost: { amountUsd: '0.000159' } });
  });

  test('narrows by exact model multi-select and returns empty results for unmatched values', async () => {
    const { origin } = await start(new Date('2026-08-19T18:00:00.000Z'), async (directory) => {
      await writeSidecar(directory, 'gpt.audit.json', sidecar('gpt'));
      await writeSidecar(
        directory,
        'mini.audit.json',
        sidecar('mini', undefined, { model: 'o4-mini', inputTokens: 7 }),
      );
    });
    const historyFor = async (query: string): Promise<HistoryResponse> =>
      (await fetch(`${origin}/api/history${query}`).then((response) => response.json())) as HistoryResponse;

    const narrowed = await historyFor('?model=o4-mini');
    expect(narrowed.total).toBe(1);
    expect(narrowed.records[0]?.recordId).toBe('mini');

    const multi = await historyFor('?model=gpt-5&model=o4-mini');
    expect(multi.total).toBe(2);
    expect(multi.records.map((record) => record.recordId)).toEqual(['gpt', 'mini']);

    const unmatched = await historyFor('?model=gpt-4');
    expect(unmatched).toMatchObject({ total: 0, records: [] });

    const unmatchedTrends = (await fetch(`${origin}/api/trends?model=gpt-4`).then((response) =>
      response.json(),
    )) as TrendsResponse;
    expect(unmatchedTrends.buckets).toEqual([]);
    expect(unmatchedTrends.total).toMatchObject({ requestCount: 0 });

    const narrowedTrends = (await fetch(`${origin}/api/trends?model=o4-mini`).then((response) =>
      response.json(),
    )) as TrendsResponse;
    expect(narrowedTrends.total).toMatchObject({ requestCount: 1, totalTokens: 11 });
  });

  test('rejects malformed ranges and pagination with a sanitized 400', async () => {
    const { origin } = await start(new Date('2026-08-19T18:00:00.000Z'));
    const badRanges = ['?from=08/01/2026', '?to=not-a-date', '?from=2026-08-10&to=2026-08-09'];
    for (const query of badRanges) {
      for (const path of ['/api/history', '/api/trends']) {
        const response = await fetch(`${origin}${path}${query}`);
        expect(response.status, `${path}${query}`).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_query' });
      }
    }
    for (const query of ['?limit=0', '?limit=201', '?offset=-1']) {
      const response = await fetch(`${origin}/api/history${query}`);
      expect(response.status, query).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_query' });
    }
  });
});

describe('Car SSE data-version signal', () => {
  test('emits data-version on ingest including out-of-today sidecars, with SSE continuity intact', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const now = new Date('2026-08-19T18:00:00.000Z');
    const service = new LiveUsageService(config(temporary.path), () => now);
    services.push(service);
    const address = await service.start();
    const origin = `http://${address.host}:${address.port}`;

    const initialHistory = (await fetch(`${origin}/api/history`).then((response) =>
      response.json(),
    )) as HistoryResponse;
    expect(initialHistory.dataVersion).toBe(0);

    const events = await fetch(`${origin}/api/events`);
    const reader = events.body!.getReader();
    let chunk = '';
    while (!chunk.includes('event: snapshot')) chunk += decode(await reader.read());
    const snapshotId = lastId(chunk);

    await writeSidecar(temporary.path, 'old.audit.json', sidecar('old', '2026-08-01T12:00:00.000Z'));
    await writeSidecar(temporary.path, 'live.audit.json', sidecar('live'));
    await service.reconcile();

    let stream = '';
    const deadline = Date.now() + 2_000;
    while (!stream.includes('"recordCount":2')) {
      if (Date.now() > deadline) throw new Error('timed out waiting for SSE frames');
      stream += decode(await reader.read());
    }
    const signals = [...stream.matchAll(/event: data-version\ndata: ([^\n]+)\n/g)].map((match) => match[1]);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    const finalSignal = JSON.parse(signals.at(-1)!) as Readonly<{ dataVersion: number }>;
    expect(Object.keys(finalSignal)).toEqual(['dataVersion']);
    expect(typeof finalSignal.dataVersion).toBe('number');
    expect(lastId(stream)).toBeGreaterThan(snapshotId);

    const history = (await fetch(`${origin}/api/history`).then((response) => response.json())) as HistoryResponse;
    expect(history.dataVersion).toBe(finalSignal.dataVersion);
    expect(history.total).toBe(2);
    const trends = (await fetch(`${origin}/api/trends`).then((response) => response.json())) as TrendsResponse;
    expect(trends.dataVersion).toBe(finalSignal.dataVersion);
    expect(trends.buckets[0]).toMatchObject({ date: '2026-08-01', requestCount: 1 });
    expect(trends.buckets.at(-1)).toMatchObject({ date: '2026-08-19', requestCount: 1 });
    expect(trends.buckets.filter((bucket) => bucket.requestCount === 1)).toHaveLength(2);
    expect(trends.total).toMatchObject({ requestCount: 2 });

    await service.reconcile();
    for (;;) {
      const quiet = decode(await reader.read());
      expect(quiet).not.toContain('event: data-version');
      if (quiet.includes(': keepalive')) break;
    }

    await writeFile(
      join(temporary.path, 'proxy-status.json'),
      JSON.stringify({
        state: 'ready',
        updatedAt: now.toISOString(),
      }),
    );
    await service.refresh();
    let statusUpdate = '';
    while (!statusUpdate.includes('event: update') && !statusUpdate.includes(': keepalive')) {
      statusUpdate += decode(await reader.read());
    }
    expect(statusUpdate).not.toContain('event: data-version');

    await reader.cancel();
  });

  test('keeps the Today summary byte-compatible in shape', async () => {
    const { origin } = await start(new Date('2026-08-19T18:00:00.000Z'), async (directory) => {
      await writeSidecar(directory, 'one.audit.json', sidecar('one'));
    });
    const summary = (await fetch(`${origin}/api/summary`).then((response) => response.json())) as Record<
      string,
      unknown
    >;
    expect(Object.keys(summary).sort()).toEqual(
      [
        'reportTimezone',
        'startInclusive',
        'endExclusive',
        'inputTokens',
        'outputTokens',
        'totalTokens',
        'requestCount',
        'latestEventTimestamp',
        'cost',
        'costUnavailableReason',
      ].sort(),
    );
    expect(summary).toMatchObject({
      reportTimezone: 'America/New_York',
      requestCount: 1,
      cost: { amountUsd: '0.000053' },
    });
  });
});

type StreamChunk = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

function decode(result: StreamChunk): string {
  return new TextDecoder().decode(result.value ?? new Uint8Array());
}

function lastId(value: string): number {
  const ids = [...value.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  return ids.at(-1)!;
}
