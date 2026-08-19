import { describe, expect, it } from 'vitest';
import type { RouteObservation } from '../src/db/route-observation-store.js';
import {
  budgetsRecording,
  carriedRoutes,
  checkBudgets,
  maxBytes,
  medianMs,
  type RouteBudgets,
  readRouteBudgets,
  recordBudgets,
  unknownBudgetRoutes,
} from './route-budgets.js';

/**
 * The budget gate's own tests.
 *
 * The gate proper judges whatever traffic this device happens to have served, so on a clean
 * clone it has nothing to judge and on a busy one it has numbers nobody chose. Everything
 * about *how it judges* is therefore tested here instead, over hand-written numbers that
 * need no database and no traffic — the role `server/test/route-budgets.test.ts` played
 * before 348f6ab deleted it along with the replay harness it rode on. A gate whose judging
 * is only exercised by the machine that would notice it failing is not a gate.
 */

function seen(route: string, durationMs: number, bytes = 0): RouteObservation {
  return { route, durationMs, bytes };
}

/** An observation that is only interesting for its size, so the duration stays out of the way. */
function sized(route: string, bytes: number): RouteObservation {
  return seen(route, 1, bytes);
}

const MB = 1024 * 1024;

const BUDGETS: RouteBudgets = {
  recordedAt: '2026-08-19T00:00:00.000Z',
  corpus: { observations: 400, note: 'fixture under test' },
  headroom: 3,
  floorMs: 50,
  floorBytes: 65_536,
  routes: { '/api/usage': { ms: 1000, bytes: 4 * MB } },
};

describe('per-route time budgets', () => {
  it('takes the middle duration, and is not moved by one outlier', () => {
    expect(medianMs([5, 1, 3])).toBe(3);
    expect(medianMs([1, 2, 3, 4])).toBe(2.5);
    // The case the median exists for: one GC pause in a few hundred responses.
    expect(medianMs([100, 105, 110, 115, 9000])).toBe(110);
    expect(medianMs([])).toBe(0);
  });

  it('passes a route sitting inside its budget, and inside the headroom above it', () => {
    expect(checkBudgets([seen('/api/usage', 900), seen('/api/usage', 1100)], BUDGETS).breaches).toEqual([]);
    // Twice the recorded number is a loaded machine, not a regression, so anything under
    // x3 has to stay green.
    expect(checkBudgets([seen('/api/usage', 2000), seen('/api/usage', 2200)], BUDGETS).breaches).toEqual([]);
  });

  /**
   * The failure this whole thing exists for, in miniature: `/api/usage` went from 3.13s to
   * 26.6s — roughly sevenfold — with the payload byte-identical throughout, and nothing in
   * the repository reported it.
   */
  it('fails the sevenfold regression that went unreported, and names the route', () => {
    const scale = 26_600 / 3130;
    const report = checkBudgets([seen('/api/usage', 1000 * scale), seen('/api/usage', 1000 * scale)], BUDGETS);
    expect(report.breaches).toHaveLength(1);
    expect(report.breaches[0]).toContain('/api/usage (time)');
    expect(report.breaches[0]).toContain('3000ms');
    // The payload never moved, so the size half is not accused of anything.
    expect(report.sizes[0]?.over).toBe(false);
  });

  /**
   * Two routes in the original fixture measured 0.1ms — they read one object already in
   * memory. Three times nothing is nothing, so without a floor the gate would judge those
   * against 0.3ms, which one scheduler hiccup crosses while nothing has regressed.
   */
  it('gives a sub-millisecond route an absolute floor rather than three times nothing', () => {
    const tiny: RouteBudgets = { ...BUDGETS, routes: { '/api/usage': { ms: 0.1, bytes: 4 * MB } } };
    // 40ms against something recorded at 0.1ms is a 400x ratio and still not a finding: at
    // this scale the timer's own noise is the whole measurement.
    expect(checkBudgets([seen('/api/usage', 40)], tiny).breaches).toEqual([]);
    expect(checkBudgets([seen('/api/usage', 40)], tiny).checks[0]?.allowedMs).toBe(50);
    // Past the floor it fails, so the floor is a floor and not an exemption.
    expect(checkBudgets([seen('/api/usage', 60)], tiny).breaches).toHaveLength(1);
    // And it never binds where the ratio still means something: 1000ms x3 wins.
    expect(checkBudgets([seen('/api/usage', 100)], BUDGETS).checks[0]?.allowedMs).toBe(3000);
  });

  it('reports a served route with no recorded budget rather than failing it', () => {
    const report = checkBudgets([seen('/api/trends', 9_999_999, 9_999_999)], BUDGETS);
    expect(report.breaches).toEqual([]);
    expect(report.unbudgeted).toEqual(['/api/trends']);
    expect(report.checks).toEqual([]);
    expect(report.sizes, 'an unbudgeted route is not judged on size either').toEqual([]);
  });

  it('reports a budgeted route with no observations rather than failing it', () => {
    const empty = checkBudgets([], BUDGETS);
    expect(empty.breaches).toEqual([]);
    expect(empty.checks).toEqual([]);
    expect(empty.unobserved).toEqual(['/api/usage']);
    expect(checkBudgets([seen('/api/usage', 10)], BUDGETS).unobserved).toEqual([]);
  });

  it('names a budget whose route no longer exists, so a rename cannot un-budget it', () => {
    expect(unknownBudgetRoutes(BUDGETS)).toEqual([]);
    expect(
      unknownBudgetRoutes({
        ...BUDGETS,
        routes: { ...BUDGETS.routes, '/api/renamed-away': { ms: 1, bytes: 1 } },
      }),
    ).toEqual(['/api/renamed-away']);
  });

  it('records a median per route, keeping the fixture prose, the headroom and both floors', () => {
    const next = recordBudgets(
      [seen('/api/summary', 10), seen('/api/summary', 20), seen('/api/usage', 5)],
      BUDGETS,
      new Date('2026-08-19T12:00:00.000Z'),
    );
    expect(next.routes).toEqual({
      '/api/summary': { ms: 15, bytes: 0 },
      '/api/usage': { ms: 5, bytes: 0 },
    });
    expect(next.recordedAt).toBe('2026-08-19T12:00:00.000Z');
    expect(next.corpus).toEqual({ observations: 3, note: 'fixture under test' });
    expect(next.headroom).toBe(3);
    expect(next.floorMs).toBe(50);
    expect(next.floorBytes).toBe(65_536);
  });

  it('keeps a budget for a route this pass saw no traffic for, rather than dropping it', () => {
    // The un-budgeting `unknownBudgetRoutes` guards against, through the other door: drop
    // an unexercised route and it reads as merely unbudgeted — reported, never failed.
    // `/api/sessions/graph/nodes` is the 3.6MB route the size half exists for.
    const previous: RouteBudgets = {
      ...BUDGETS,
      routes: { ...BUDGETS.routes, '/api/sessions/graph/nodes': { ms: 120, bytes: 3.6 * MB } },
    };

    const next = recordBudgets([seen('/api/usage', 20)], previous, new Date('2026-08-19T12:00:00.000Z'));

    expect(next.routes['/api/usage']).toEqual({ ms: 20, bytes: 0 });
    expect(next.routes['/api/sessions/graph/nodes']).toEqual({ ms: 120, bytes: 3.6 * MB });
    expect(carriedRoutes([seen('/api/usage', 20)], previous)).toEqual(['/api/sessions/graph/nodes']);
  });

  it('names nothing as carried when the pass measured every budgeted route', () => {
    expect(carriedRoutes([seen('/api/usage', 20)], BUDGETS)).toEqual([]);
    // A route measured for the first time is new, not carried.
    expect(carriedRoutes([seen('/api/usage', 20), seen('/api/summary', 5)], BUDGETS)).toEqual([]);
  });

  it('records only when asked, and carries no other environment switch', () => {
    expect(budgetsRecording({})).toBe(false);
    expect(budgetsRecording({ ROUTE_BUDGETS: 'record' })).toBe(true);
    // The old `ROUTE_BUDGETS=0` escape hatch is deliberately gone: it existed for a
    // twenty-minute replay that could fail on a busy machine, and this gate reads a table.
    expect(budgetsRecording({ ROUTE_BUDGETS: '0' })).toBe(false);
  });
});

/**
 * The size half of the same gate.
 *
 * Assembling an enormous payload is cheap, so a time budget is structurally incapable of
 * seeing one: `/api/sessions/graph` answered in 152.9ms and handed back 28.2MB. Judged over
 * hand-written sizes here, for the reason the durations above are hand-written.
 */
describe('per-route response size budgets', () => {
  it('takes the largest answer, not the middle one', () => {
    expect(maxBytes([5, 1, 3])).toBe(5);
    expect(maxBytes([1_000, 1_000, 28 * MB])).toBe(28 * MB);
    expect(maxBytes([])).toBe(0);
  });

  it('passes a route inside its budget, and inside the headroom above it', () => {
    expect(checkBudgets([sized('/api/usage', 3 * MB), sized('/api/usage', 4 * MB)], BUDGETS).breaches).toEqual([]);
    // The same x3 the durations get: a corpus that grew is not a regression.
    expect(checkBudgets([sized('/api/usage', 12 * MB)], BUDGETS).breaches).toEqual([]);
  });

  /** The failure this half exists for: fast and enormous, with nothing watching the size. */
  it('fails a route that answers quickly with a payload that grew', () => {
    const report = checkBudgets([seen('/api/usage', 152.9, 28.2 * MB)], BUDGETS);
    expect(report.breaches).toHaveLength(1);
    expect(report.breaches[0]).toContain('/api/usage (size)');
    expect(report.breaches[0]).toContain('28.2MB');
    expect(report.breaches[0]).toContain('12.0MB');
    // The duration was never in question, so it is not accused.
    expect(report.checks.every((c) => c.over)).toBe(false);
    expect(report.sizes[0]?.over).toBe(true);
  });

  /**
   * The byte counterpart of the millisecond floor, and there for the same reason: several
   * routes answer with one small object, and x3 of a two-figure payload is an allowance a
   * single added field crosses.
   */
  it('gives a tiny payload an absolute floor rather than three times nothing', () => {
    const tiny: RouteBudgets = { ...BUDGETS, routes: { '/api/usage': { ms: 1, bytes: 11 } } };
    expect(checkBudgets([sized('/api/usage', 40_000)], tiny).breaches).toEqual([]);
    expect(checkBudgets([sized('/api/usage', 40_000)], tiny).sizes[0]?.allowedBytes).toBe(65_536);
    // Past the floor it fails, so the floor is a floor and not an exemption.
    expect(checkBudgets([sized('/api/usage', 65_537)], tiny).breaches).toHaveLength(1);
    // And it never binds where the ratio means something: 4MB x3 wins.
    expect(checkBudgets([sized('/api/usage', 100)], BUDGETS).sizes[0]?.allowedBytes).toBe(12 * MB);
  });

  it('judges size once per route, however many observations it has', () => {
    const report = checkBudgets([sized('/api/usage', 1_000), sized('/api/usage', 2_000)], BUDGETS);
    expect(report.sizes).toHaveLength(1);
    expect(report.sizes[0]).toMatchObject({ route: '/api/usage', observations: 2, bytes: 2_000 });
    // One time check as well, over the same two observations — the halves are not confused.
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]?.observations).toBe(2);
  });

  it('records the largest size per route', () => {
    const next = recordBudgets(
      [sized('/api/summary', 900), sized('/api/summary', 1_500), sized('/api/usage', 20)],
      BUDGETS,
      new Date('2026-08-19T12:00:00.000Z'),
    );
    expect(next.routes['/api/summary']?.bytes).toBe(1_500);
    expect(next.routes['/api/usage']?.bytes).toBe(20);
  });
});

describe('the shipped fixture', () => {
  it('names only declared routes, and records a positive number for each', () => {
    const budgets = readRouteBudgets();
    expect(unknownBudgetRoutes(budgets)).toEqual([]);
    expect(budgets.headroom).toBeGreaterThan(1);
    expect(budgets.floorMs).toBeGreaterThan(0);
    expect(budgets.floorBytes).toBeGreaterThan(0);
    expect(Object.keys(budgets.routes).length, 'the fixture records nothing, so it gates nothing').toBeGreaterThan(0);
    for (const [route, budget] of Object.entries(budgets.routes)) {
      // Zero is a real measurement, not a missing one: the column is an integer and two
      // routes here answer from one already-loaded object in well under half a
      // millisecond. The 50ms floor is what judges those, so the rounding costs nothing.
      expect(budget.ms, `${route} ms`).toBeGreaterThanOrEqual(0);
      expect(budget.bytes, `${route} bytes`).toBeGreaterThan(0);
    }
  });
});
