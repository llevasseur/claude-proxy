import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, SCHEMA_VERSION } from '../src/db/open.js';
import {
  closeRouteObservations,
  OBSERVATIONS_PER_ROUTE,
  pruneRouteObservations,
  readRouteObservations,
  recordRouteObservation,
} from '../src/db/route-observation-store.js';

/**
 * The observation table schema v22 adds, and the store that writes it.
 *
 * The measurement side of the route budgets, tested against a temporary log directory —
 * `route-budget-gate.test.ts` judges whatever this device really served, and that is not a
 * corpus a test can assert against.
 */

const dirs: string[] = [];

async function logDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'route-observations-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  closeRouteObservations();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('the route observation store', () => {
  it('records nothing where there is no substrate, and creates none', async () => {
    const dir = await logDir();
    // A read route must not leave a database behind in a log directory that had none.
    recordRouteObservation(dir, { route: '/api/usage', durationMs: 12, bytes: 3400 });
    expect(readRouteObservations(dir)).toEqual([]);
  });

  it('appends one row per observation once the substrate exists', async () => {
    const dir = await logDir();
    openDb(dir).close();

    recordRouteObservation(dir, { route: '/api/usage', durationMs: 12, bytes: 3400 });
    recordRouteObservation(dir, { route: '/api/usage', durationMs: 18, bytes: 3600 });
    recordRouteObservation(dir, { route: '/api/summary', durationMs: 5, bytes: 900 });

    expect(readRouteObservations(dir)).toEqual([
      { route: '/api/summary', durationMs: 5, bytes: 900 },
      { route: '/api/usage', durationMs: 12, bytes: 3400 },
      { route: '/api/usage', durationMs: 18, bytes: 3600 },
    ]);
  });

  it('rounds a fractional duration, because the verdict cannot turn on a fraction', async () => {
    const dir = await logDir();
    openDb(dir).close();
    // `performance.now()` answers in fractions; the column is an integer, and a median
    // judged with x3 headroom and a 50ms floor cannot be moved by half a millisecond.
    recordRouteObservation(dir, { route: '/api/health', durationMs: 0.4, bytes: 11 });
    recordRouteObservation(dir, { route: '/api/health', durationMs: 1.6, bytes: 11 });
    expect(readRouteObservations(dir).map((o) => o.durationMs)).toEqual([0, 2]);
  });

  it('caps what each route keeps, so a long-lived server cannot grow the table without bound', async () => {
    const dir = await logDir();
    openDb(dir).close();

    const overflow = OBSERVATIONS_PER_ROUTE + 25;
    for (let i = 0; i < overflow; i++) {
      recordRouteObservation(dir, { route: '/api/usage', durationMs: i, bytes: 100 + i });
    }
    // The cap is enforced on a cadence rather than per insert, so ask for it directly.
    pruneRouteObservations(dir);

    const kept = readRouteObservations(dir);
    expect(kept).toHaveLength(OBSERVATIONS_PER_ROUTE);
    // The newest are what survive: an old duration says nothing about the route today.
    expect(kept.at(-1)?.durationMs).toBe(overflow - 1);
    expect(kept[0]?.durationMs).toBe(overflow - OBSERVATIONS_PER_ROUTE);
  });

  it('caps each route on its own, not the table as a whole', async () => {
    const dir = await logDir();
    openDb(dir).close();

    for (let i = 0; i < OBSERVATIONS_PER_ROUTE + 10; i++) {
      recordRouteObservation(dir, { route: '/api/usage', durationMs: i, bytes: 100 });
    }
    recordRouteObservation(dir, { route: '/api/health', durationMs: 1, bytes: 11 });
    pruneRouteObservations(dir);

    const kept = readRouteObservations(dir);
    expect(kept.filter((o) => o.route === '/api/health')).toHaveLength(1);
    expect(kept.filter((o) => o.route === '/api/usage')).toHaveLength(OBSERVATIONS_PER_ROUTE);
  });

  it('reads an unmigrated database as no observations rather than throwing', async () => {
    const dir = await logDir();
    const db = openDb(dir);
    db.exec('DROP TABLE route_observation');
    db.close();
    // The state a database written by an older checkout is in. The gate reports it as
    // nothing recorded, which is exactly what it is.
    expect(readRouteObservations(dir)).toEqual([]);
  });

  it('ships the table at the schema version that introduced it', async () => {
    const dir = await logDir();
    const db = openDb(dir);
    // SAFETY: `PRAGMA user_version` answers one row whose single column carries that name.
    const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    db.close();
    expect(row?.user_version).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION, 'route_observation arrived in v22').toBeGreaterThanOrEqual(22);
  });
});
