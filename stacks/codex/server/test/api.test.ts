import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

describe('Bike API', () => {
  test('reports readiness, healthy proxy state, and an empty Today summary', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const { origin } = await start(now, async (directory) => {
      await writeFile(
        join(directory, 'proxy-status.json'),
        JSON.stringify({ state: 'ready', updatedAt: '2026-08-19T17:59:00.000Z' }),
      );
    });
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    const summary = await fetch(`${origin}/api/summary`).then((response) => response.json());

    expect(health).toMatchObject({
      ready: true,
      server: { status: 'ready' },
      proxy: { status: 'healthy', state: 'ready' },
      database: { status: 'ready', schemaVersion: 2 },
      ingest: { rejectedSidecars: 0 },
      sse: { subscribers: 0 },
    });
    expect(summary).toMatchObject({
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latestEventTimestamp: null,
      reportTimezone: 'America/New_York',
      cost: { currency: 'USD', amountUsd: '0.000000' },
      costUnavailableReason: null,
    });
  });

  test('serves complete and explicitly unavailable aggregate costs', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const complete = await start(now, async (directory) => {
      await writeSidecar(directory, 'one.audit.json', sidecar('one'));
    });
    expect(await fetch(`${complete.origin}/api/summary`).then((response) => response.json())).toMatchObject({
      requestCount: 1,
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cost: { currency: 'USD', amountUsd: '0.000053' },
      costUnavailableReason: null,
    });

    const unavailable = await start(now, async (directory) => {
      await writeSidecar(directory, 'unknown.audit.json', sidecar('unknown', undefined, { unavailable: true }));
    });
    expect(await fetch(`${unavailable.origin}/api/summary`).then((response) => response.json())).toMatchObject({
      requestCount: 1,
      cost: null,
      costUnavailableReason: { code: 'aggregate-incomplete', detail: 'unknown-model' },
    });
  });

  test('uses report-timezone boundaries across midnight and daylight-saving changes', async () => {
    const now = new Date('2026-03-08T16:00:00.000Z');
    const { origin } = await start(now, async (directory) => {
      await writeSidecar(directory, 'before.audit.json', sidecar('before', '2026-03-08T04:59:59.000Z'));
      await writeSidecar(directory, 'today.audit.json', sidecar('today', '2026-03-08T05:00:00.000Z'));
    });
    const summary = await fetch(`${origin}/api/summary`).then((response) => response.json());
    expect(summary).toMatchObject({
      requestCount: 1,
      startInclusive: '2026-03-08T05:00:00.000Z',
      endExclusive: '2026-03-09T04:00:00.000Z',
    });
  });

  test('degrades safely for malformed status and sanitizes errors', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const { origin } = await start(now, async (directory) => {
      await writeFile(join(directory, 'proxy-status.json'), '{secret');
      await writeFile(join(directory, 'bad.audit.json'), '{private prompt');
    });
    const health = await fetch(`${origin}/api/health`).then((response) => response.json());
    const missing = await fetch(`${origin}/private?secret=do-not-return`);
    expect(health).toMatchObject({ proxy: { status: 'unavailable' }, ingest: { rejectedSidecars: 1 } });
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });
});
