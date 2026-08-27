import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ApiContext } from '../src/api.ts';
import { handleApiRequest } from '../src/api.ts';
import { openNetDatabase } from '../src/db.ts';
import type { JsonValue } from '../src/json.ts';

// Fixed clock: 2026-08-20T12:00:00Z, a Thursday. Timezone pinned to UTC so the
// day bucketing in these cases is readable straight off the timestamps.
const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);

function makeContext(seed?: (db: DatabaseSync) => void): ApiContext {
  const db = openNetDatabase(':memory:');
  seed?.(db);
  return { db, clock: () => NOW, timeZone: 'UTC' };
}

function insertSample(
  db: DatabaseSync,
  row: {
    timestamp: number;
    bootEpoch?: number;
    name: string;
    pid: number;
    interface: string;
    bytesIn: number;
    bytesOut: number;
  },
): void {
  db.prepare(
    'INSERT INTO sample (timestamp, boot_epoch, name, pid, interface, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.timestamp, row.bootEpoch ?? 1_756_147_200, row.name, row.pid, row.interface, row.bytesIn, row.bytesOut);
}

function get(ctx: ApiContext, path: string) {
  return handleApiRequest(ctx, 'GET', new URL(path, 'http://localhost'), {
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
}

describe('GET /api/summary', () => {
  it('returns the empty shape over a fresh database', () => {
    const reply = get(makeContext(), '/api/summary');
    expect(reply?.status).toBe(200);
    expect(reply?.headers['access-control-allow-origin']).toBe('*');
    expect(reply?.body).toMatchObject({
      lastSampleAt: null,
      bootEpoch: null,
      coverage: { sampleCount: 0, firstSampleAt: null },
      period: null,
      totals: { bytesIn: 0, bytesOut: 0 },
      agentShare: [],
      config: { limitBytes: null, resetDay: null, agentPatterns: ['node', 'claude', 'Claude', 'codex', 'ox'] },
    });
  });

  it('totals wire bytes over en* interfaces only, per decision internet-spend 001', () => {
    const ctx = makeContext((db) => {
      // en0 deltas: 1000 in / 500 out. utun3 is excluded from the headline.
      insertSample(db, {
        timestamp: NOW - 3_600_000,
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 1000,
        bytesOut: 500,
      });
      insertSample(db, {
        timestamp: NOW - 3_600_000,
        name: 'node',
        pid: 2,
        interface: 'utun3',
        bytesIn: 99_999,
        bytesOut: 99_999,
      });
      insertSample(db, { timestamp: NOW, name: 'node', pid: 1, interface: 'en0', bytesIn: 2000, bytesOut: 1000 });
      insertSample(db, {
        timestamp: NOW,
        name: 'node',
        pid: 2,
        interface: 'utun3',
        bytesIn: 199_999,
        bytesOut: 199_999,
      });
    });
    // SAFETY: `/api/summary` answers 200 with a JSON object for every seeded
    // fixture; the assertion only unlocks reading its keys to compare them.
    const body = get(ctx, '/api/summary')?.body as Record<string, never>;
    expect(body.totals).toEqual({ bytesIn: 1000, bytesOut: 500 });
    expect(body.coverage).toEqual({ sampleCount: 4, firstSampleAt: NOW - 3_600_000 });
  });

  it('labels agent share by stripped process name under substring patterns', () => {
    const ctx = makeContext((db) => {
      insertSample(db, {
        timestamp: NOW - 3_600_000,
        name: 'Claude Helper (Renderer)',
        pid: 901,
        interface: 'en0',
        bytesIn: 0,
        bytesOut: 0,
      });
      insertSample(db, {
        timestamp: NOW - 3_600_000,
        name: 'Safari',
        pid: 400,
        interface: 'en0',
        bytesIn: 0,
        bytesOut: 0,
      });
      insertSample(db, {
        timestamp: NOW,
        name: 'Claude Helper (Renderer)',
        pid: 901,
        interface: 'en0',
        bytesIn: 700,
        bytesOut: 300,
      });
      insertSample(db, { timestamp: NOW, name: 'Safari', pid: 400, interface: 'en0', bytesIn: 5000, bytesOut: 5000 });
    });
    // SAFETY: `/api/summary` answers 200 with a JSON object for every seeded
    // fixture; the assertion only unlocks reading its keys to compare them.
    const body = get(ctx, '/api/summary')?.body as Record<string, never>;
    expect(body.agentShare).toEqual([{ name: 'Claude Helper (Renderer)', bytes: 1000 }]);
  });

  it('reports period bounds per decision internet-spend 003 with an unset resetDay', () => {
    const ctx = makeContext((db) => {
      insertSample(db, { timestamp: NOW, name: 'node', pid: 1, interface: 'en0', bytesIn: 1, bytesOut: 1 });
    });
    // SAFETY: `/api/summary` answers 200 with a JSON object for every seeded
    // fixture; the assertion only unlocks reading its keys to compare them.
    const body = get(ctx, '/api/summary')?.body as Record<string, never>;
    expect(body.period).toEqual({ start: '2026-08-01', end: '2026-08-31' });
  });
});

describe('GET /api/days', () => {
  it('emits one entry per local calendar day in the window and marks hole days not-known', () => {
    const ctx = makeContext((db) => {
      // Two samples one hour apart on Aug 18 only; Aug 19-20 are holes.
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 18, 10),
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 100,
        bytesOut: 50,
      });
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 18, 11),
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 400,
        bytesOut: 250,
      });
    });
    const reply = get(ctx, '/api/days?window=3');
    // SAFETY: `/api/days` answers 200 with `{ days, gaps }`, and `days` carries
    // one entry per day in the window with exactly these four fields.
    const body = reply?.body as { days: Array<{ date: string; bytesIn: number; bytesOut: number; known: boolean }> };
    expect(body.days).toHaveLength(3);
    expect(body.days.map((day) => [day.date, day.bytesIn, day.known])).toEqual([
      ['2026-08-20', 0, false],
      ['2026-08-19', 0, false],
      ['2026-08-18', 300, true],
    ]);
  });

  it('clamps the window into 1..366', () => {
    const ctx = makeContext();
    const low = get(ctx, '/api/days?window=-5');
    const high = get(ctx, '/api/days?window=9999');
    // SAFETY: both requests hit `/api/days`, which always answers a body
    // carrying a `days` array; only its length is read here.
    expect((low?.body as { days: unknown[] } | undefined)?.days).toHaveLength(1);
    // SAFETY: as above — the same route, the same guaranteed `days` array.
    expect((high?.body as { days: unknown[] } | undefined)?.days).toHaveLength(366);
  });

  it('surfaces typed hatch spans for boot changes and gaps', () => {
    const ctx = makeContext((db) => {
      const bootA = 1_756_147_200;
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 10, 10),
        bootEpoch: bootA,
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 0,
        bytesOut: 0,
      });
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 10, 11),
        bootEpoch: bootA,
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 100,
        bytesOut: 0,
      });
      // A reboot between: next sample carries a different boot epoch.
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 15, 10),
        bootEpoch: bootA + 500_000,
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 0,
        bytesOut: 0,
      });
      insertSample(db, {
        timestamp: Date.UTC(2026, 7, 15, 11),
        bootEpoch: bootA + 500_000,
        name: 'node',
        pid: 1,
        interface: 'en0',
        bytesIn: 30,
        bytesOut: 0,
      });
    });
    // SAFETY: `/api/days` always answers a `gaps` array, and this fixture seeds
    // a boot change, so each entry carries the start/end/kind triple read below.
    const body = get(ctx, '/api/days?window=30')?.body as {
      gaps: Array<{ start: number; end: number; kind: string }>;
    };
    const kinds = body.gaps.map((gap) => gap.kind);
    expect(kinds).toContain('boot');
  });
});

describe('config routes', () => {
  const ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

  function request(ctx: ApiContext, method: string, path: string, options: { origin?: string; body?: JsonValue } = {}) {
    return handleApiRequest(ctx, method, new URL(path, 'http://localhost'), {
      origin: options.origin,
      body: options.body,
      allowedOrigins: ORIGINS,
    });
  }

  it('GET /api/config returns defaults open-CORS', () => {
    const reply = get(makeContext(), '/api/config');
    expect(reply?.status).toBe(200);
    expect(reply?.headers['access-control-allow-origin']).toBe('*');
    expect(reply?.body).toMatchObject({ limitBytes: null, resetDay: null });
  });

  it('PUT persists a valid subset and echoes an allowed origin', () => {
    const ctx = makeContext();
    const reply = request(ctx, 'PUT', '/api/config', {
      origin: 'http://localhost:5173',
      body: { limitBytes: 1073741824, resetDay: 15 },
    });
    expect(reply?.status).toBe(200);
    expect(reply?.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(reply?.body).toMatchObject({ limitBytes: 1073741824, resetDay: 15 });

    // Persisted: a fresh context over the same db sees it.
    expect(get(ctx, '/api/config')?.body).toMatchObject({ limitBytes: 1073741824, resetDay: 15 });
  });

  it('rejects invalid values with 400 and persists nothing', () => {
    const ctx = makeContext();
    const invalidBodies: JsonValue[] = [
      { limitBytes: 0 },
      { limitBytes: 1.5 },
      { limitBytes: -10 },
      { resetDay: 0 },
      { resetDay: 32 },
      { agentPatterns: [''] },
      { agentPatterns: 'node' },
      'not-an-object',
    ];
    for (const body of invalidBodies) {
      const reply = request(ctx, 'PUT', '/api/config', { origin: 'http://127.0.0.1:5173', body });
      expect(reply?.status).toBe(400);
    }
    expect(get(ctx, '/api/config')?.body).toMatchObject({ limitBytes: null, resetDay: null });
  });

  it('refuses a PUT declaring a disallowed origin', () => {
    const ctx = makeContext();
    const reply = request(ctx, 'PUT', '/api/config', {
      origin: 'http://evil.example',
      body: { limitBytes: 5 },
    });
    expect(reply?.status).toBe(403);
    expect(reply?.headers['access-control-allow-origin']).toBeUndefined();
    // Nothing persisted.
    expect(get(ctx, '/api/config')?.body).toMatchObject({ limitBytes: null });
  });

  it('allows an origin-less PUT (non-browser client) and answers OPTIONS preflight', () => {
    const ctx = makeContext();
    const put = request(ctx, 'PUT', '/api/config', { body: { agentPatterns: ['node'] } });
    expect(put?.status).toBe(200);
    expect(put?.headers['access-control-allow-origin']).toBeUndefined();

    const preflight = request(ctx, 'OPTIONS', '/api/config', { origin: 'http://localhost:5173' });
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers['access-control-allow-methods']).toContain('PUT');
  });

  it('answers 405 for wrong methods and null for unknown paths', () => {
    const ctx = makeContext();
    expect(request(ctx, 'POST', '/api/summary')?.status).toBe(405);
    expect(request(ctx, 'DELETE', '/api/config')?.status).toBe(405);
    expect(request(ctx, 'DELETE', '/api/config')?.headers.vary).toBe('origin');
    expect(get(ctx, '/api/nope')).toBeNull();
  });
});
