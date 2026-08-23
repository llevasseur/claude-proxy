import { mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { CaptureStore, isFinalCaptureFilename } from '../src/capture.ts';
import { LiveUsageService } from '../src/service.ts';
import { config, sidecar, temporaryDirectory, writeSidecar } from './helpers.ts';

const services: LiveUsageService[] = [];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function captureFile(
  directory: string,
  name: string,
  body = JSON.stringify({ secret: 'sk-test-abcdef0123456789' }),
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, body);
  return path;
}

describe('capture retention', () => {
  test('deletes captures past the retention window and keeps fresh ones', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const captures = join(temporary.path, 'captures');
    const expired = await captureFile(captures, 'old.capture.json');
    const fresh = await captureFile(captures, 'new.capture.json');
    const old = new Date(Date.now() - 10_000);
    await utimes(expired, old, old);

    const store = new CaptureStore(captures, true, 5_000, 268_435_456);
    const result = await store.maintain();

    expect(result.deletedExpired).toBe(1);
    expect(result.remainingFiles).toBe(1);
    await expect(readFile(expired)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(fresh, 'utf8'))).toMatchObject({ secret: expect.any(String) });
  });

  test('enforces the size cap by deleting oldest captures first', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const captures = join(temporary.path, 'captures');
    // Each file is 40 bytes; cap at 90 bytes so only the oldest must go.
    await captureFile(captures, 'a.capture.json', 'x'.repeat(40));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await captureFile(captures, 'b.capture.json', 'y'.repeat(40));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await captureFile(captures, 'c.capture.json', 'z'.repeat(40));

    const store = new CaptureStore(captures, true, 604_800_000, 90);
    const result = await store.maintain();

    expect(result.examined).toBe(3);
    expect(result.deletedOverCap).toBe(1);
    expect(result.remainingFiles).toBe(2);
    const remaining = (await readdir(captures)).filter(isFinalCaptureFilename);
    expect(remaining).toEqual(['b.capture.json', 'c.capture.json']);
  });

  test('a server with capture disabled never touches capture files', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const captures = join(temporary.path, 'captures');
    const kept = await captureFile(captures, 'kept.capture.json');
    const old = new Date(Date.now() - 100_000);
    await utimes(kept, old, old);

    const store = new CaptureStore(captures, false, 1_000, 1);
    const result = await store.maintain();

    expect(result).toMatchObject({ examined: 0, deletedExpired: 0 });
    expect(await readFile(kept, 'utf8')).toContain('sk-test');
  });

  test('acceptance gate parses strict envelope v1 only when enabled', async () => {
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const good = await captureFile(
      temporary.path,
      'good.capture.json',
      JSON.stringify({
        schemaVersion: 1,
        recordId: '0b9e6c1e-5f2a-4a3b-9c8d-112233445566',
        capturedAt: '2026-08-22T12:00:00.000Z',
        endpoint: '/v1/responses',
        requestText: '[redacted]',
        responseText: '',
      }),
    );
    const bad = await captureFile(temporary.path, 'bad.capture.json', '{"model":"gpt-5"}');

    const enabled = new CaptureStore(temporary.path, true, 604_800_000, 268_435_456);
    expect((await enabled.load(good)).schemaVersion).toBe(1);
    await expect(enabled.load(bad)).rejects.toThrow(/unknown field model/);
    await expect(enabled.load(join(temporary.path, 'missing.capture.json'))).rejects.toThrow();

    const disabled = new CaptureStore(temporary.path, false, 604_800_000, 268_435_456);
    await expect(disabled.load(good)).rejects.toThrow(/capture is disabled/);
  });
});

describe('capture isolation from Bike/Car', () => {
  test('stray capture files in the audit directory never corrupt ingest or summaries', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    await writeSidecar(temporary.path, 'one.audit.json', sidecar('one'));
    // A misconfigured proxy pointed CAPTURE_DIR at AUDIT_DIR.
    await captureFile(
      temporary.path,
      'stray.capture.json',
      JSON.stringify({ schemaVersion: 9, junk: 'not a sidecar' }),
    );
    const service = new LiveUsageService(config(temporary.path), () => now);
    services.push(service);
    await service.reconcile();

    const summary = service.summary() as Record<string, unknown>;
    expect(summary.requestCount).toBe(1);
    const health = service.health() as Record<string, any>;
    expect(health.ingest.rejectedSidecars).toBe(0);
    expect(health.capture.enabled).toBe(false);
  });

  test('Bike/Car stay fully useful with zero inspection data present', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    await writeSidecar(temporary.path, 'one.audit.json', sidecar('one'));
    await writeSidecar(temporary.path, 'two.audit.json', sidecar('two'));
    const service = new LiveUsageService(config(temporary.path), () => now);
    services.push(service);
    await service.start();

    const health = service.health() as Record<string, any>;
    expect(health.capture.enabled).toBe(false);
    const summary = service.summary() as Record<string, unknown>;
    expect(summary.requestCount).toBe(2);
    expect(summary.totalTokens).toBe(28);

    // Starting the server must not conjure a capture directory into existence.
    await expect(stat(join(temporary.path, 'captures'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(temporary.path, 'usage.db'), { force: true });
  });

  test('health reflects the shared opt-in flag when enabled', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    const service = new LiveUsageService(config(temporary.path, { captureEnabled: true }), () => now);
    services.push(service);
    await service.start();
    expect((service.health() as Record<string, any>).capture.enabled).toBe(true);
  });

  test('summaries stay exact with capture enabled and a valid capture present', async () => {
    const now = new Date('2026-08-19T18:00:00.000Z');
    const temporary = await temporaryDirectory();
    cleanups.push(temporary.cleanup);
    await writeSidecar(temporary.path, 'one.audit.json', sidecar('one'));
    const captures = join(temporary.path, 'captures');
    await mkdir(captures, { recursive: true });
    await writeFile(
      join(captures, '2026-08-19T16:00:00.000Z_one.capture.json'),
      JSON.stringify({
        schemaVersion: 1,
        recordId: 'one',
        capturedAt: '2026-08-19T16:00:00.000Z',
        endpoint: '/v1/responses',
        requestText: JSON.stringify({ model: 'gpt-5', instructions: 'be brief', input: [] }),
        responseText: 'ok',
      }),
    );
    const service = new LiveUsageService(config(temporary.path, { captureEnabled: true }), () => now);
    services.push(service);
    await service.reconcile();

    const summary = service.summary() as Record<string, unknown>;
    expect(summary.requestCount).toBe(1);
    expect(summary.totalTokens).toBe(14);
  });
});
