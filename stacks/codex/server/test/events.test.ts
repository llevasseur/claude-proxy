import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { LiveUsageService } from '../src/service.ts';
import { config, sidecar, temporaryDirectory, writeSidecar } from './helpers.ts';

const services: LiveUsageService[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function nextChunk(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs = 500): Promise<string> {
  const result = await Promise.race([
    reader.read(),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for SSE')), timeoutMs),
    ),
  ]);
  return new TextDecoder().decode(result.value);
}

function ids(value: string): number[] {
  return [...value.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

test('SSE sends snapshots, updates, keepalives, monotonic reconnect IDs, and cleans up subscribers', async () => {
  const temporary = await temporaryDirectory();
  cleanups.push(temporary.cleanup);
  const now = new Date('2026-08-19T18:00:00.000Z');
  const service = new LiveUsageService(config(temporary.path), () => now);
  services.push(service);
  const address = await service.start();
  const origin = `http://${address.host}:${address.port}`;

  const firstResponse = await fetch(`${origin}/api/events`);
  const firstReader = firstResponse.body!.getReader();
  let initial = '';
  while (!initial.includes('event: snapshot')) initial += await nextChunk(firstReader);
  expect(initial).toContain('retry: 2000');
  expect(initial).toContain('event: snapshot');
  expect(initial).toContain('"requestCount":0');
  const initialId = ids(initial)[0]!;
  const connectedHealth = (await fetch(`${origin}/api/health`).then((response) => response.json())) as {
    sse: { subscribers: number };
  };
  expect(connectedHealth.sse.subscribers).toBe(1);

  await writeSidecar(temporary.path, 'live.audit.json', sidecar('live'));
  await service.reconcile();
  let update = '';
  while (!update.includes('event: update')) update += await nextChunk(firstReader);
  expect(update).toContain('"requestCount":1');
  const updateId = ids(update).at(-1)!;
  expect(updateId).toBeGreaterThan(initialId);

  await service.reconcile();
  const keepalive = await nextChunk(firstReader);
  expect(keepalive).toContain(': keepalive');
  expect(keepalive).not.toContain('event: update');

  await writeFile(
    join(temporary.path, 'proxy-status.json'),
    JSON.stringify({ state: 'upstream-error', updatedAt: '2026-08-19T18:00:00.000Z' }),
  );
  await service.refresh();
  let statusUpdate = '';
  while (!statusUpdate.includes('event: update')) statusUpdate += await nextChunk(firstReader);
  expect(statusUpdate).toContain('"state":"upstream-error"');
  expect(ids(statusUpdate).at(-1)!).toBeGreaterThan(updateId);

  const reconnectResponse = await fetch(`${origin}/api/events`, { headers: { 'last-event-id': String(updateId) } });
  const reconnectReader = reconnectResponse.body!.getReader();
  let reconnect = '';
  while (!reconnect.includes('event: snapshot')) reconnect += await nextChunk(reconnectReader);
  expect(reconnect).toContain('event: snapshot');
  expect(ids(reconnect)[0]!).toBeGreaterThan(ids(statusUpdate).at(-1)!);

  await firstReader.cancel();
  await reconnectReader.cancel();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const disconnectedHealth = (await fetch(`${origin}/api/health`).then((response) => response.json())) as {
    sse: { subscribers: number };
  };
  expect(disconnectedHealth.sse.subscribers).toBe(0);
});
