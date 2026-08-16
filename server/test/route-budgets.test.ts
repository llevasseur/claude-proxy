import { describe, expect, it } from 'vitest';
import {
  budgetsEnabled,
  budgetsRecording,
  type CaseTiming,
  checkBudgets,
  medianMs,
  PARITY_ROUTES,
  type RouteBudgets,
  recordBudgets,
  unknownBudgetRoutes,
} from '../src/parity.js';
import { readRouteBudgets } from './route-budgets.js';

/**
 * The budget gate's own tests.
 *
 * The gate itself only runs where there is a real archive to replay, which is
 * one device and not CI — so everything about *how it judges* is tested here
 * instead, over hand-written durations that need no corpus. A gate that only
 * executes on the machine that would notice it failing is not a gate.
 */

function timing(route: string, filesMs: number, dbMs: number, label = route): CaseTiming {
  return { route, label, filesMs, dbMs };
}

const BUDGETS: RouteBudgets = {
  recordedAt: '2026-08-16T00:00:00.000Z',
  corpus: { archivedDays: 24, note: 'fixture under test' },
  headroom: 3,
  floorMs: 50,
  routes: { '/api/usage': { files: 1000, db: 1000 } },
};

describe('per-route time budgets', () => {
  it('takes the middle duration, and is not moved by one outlier', () => {
    expect(medianMs([5, 1, 3])).toBe(3);
    expect(medianMs([1, 2, 3, 4])).toBe(2.5);
    // The case the median exists for: one GC pause in a replay of five.
    expect(medianMs([100, 105, 110, 115, 9000])).toBe(110);
    expect(medianMs([])).toBe(0);
  });

  it('passes a route sitting inside its budget, and inside the headroom above it', () => {
    const inside = checkBudgets([timing('/api/usage', 900, 950), timing('/api/usage', 1100, 1050)], BUDGETS);
    expect(inside.breaches).toEqual([]);

    // Twice the recorded number is a loaded machine, not a regression, so
    // anything under ×3 has to stay green.
    const loaded = checkBudgets([timing('/api/usage', 2000, 2200)], BUDGETS);
    expect(loaded.breaches).toEqual([]);
  });

  /**
   * The failure this whole thing exists for, in miniature: `/api/usage` went
   * from 3.13s to 26.6s — roughly sevenfold — with the payload byte-identical
   * throughout, and nothing reported it.
   */
  it('fails the sevenfold regression that went unreported', () => {
    const scale = 26_600 / 3130;
    const regressed = checkBudgets(
      [timing('/api/usage', 1000, 1000 * scale), timing('/api/usage', 1000, 1000 * scale)],
      BUDGETS,
    );
    expect(regressed.breaches).toHaveLength(1);
    expect(regressed.breaches[0]).toContain('/api/usage (db)');
    expect(regressed.breaches[0]).toContain('3000ms');
    // The file backing did not move, so it is not accused of anything.
    expect(regressed.checks.find((c) => c.backing === 'files')?.over).toBe(false);
  });

  /**
   * Two routes in the shipped fixture measure 0.1ms — they read one object that
   * is already in memory. Three times nothing is nothing, so without a floor the
   * gate would be judging those two against 0.3ms, which one scheduler hiccup
   * crosses while nothing has regressed.
   */
  it('gives a sub-millisecond route an absolute floor rather than three times nothing', () => {
    const tiny: RouteBudgets = { ...BUDGETS, routes: { '/api/usage': { files: 0.1, db: 0.1 } } };
    // 40ms for something recorded at 0.1ms is a 400x ratio and still not a
    // finding: at this scale the timer's own noise is the whole measurement.
    expect(checkBudgets([timing('/api/usage', 40, 40)], tiny).breaches).toEqual([]);
    expect(checkBudgets([timing('/api/usage', 40, 40)], tiny).checks[0]?.allowedMs).toBe(50);
    // Past the floor it fails, so the floor is a floor and not an exemption.
    expect(checkBudgets([timing('/api/usage', 60, 60)], tiny).breaches).toHaveLength(2);
    // The floor never binds where the ratio means something: 1000ms x3 wins.
    expect(checkBudgets([timing('/api/usage', 100, 100)], BUDGETS).checks[0]?.allowedMs).toBe(3000);
  });

  it('reports a route with no recorded budget rather than failing it', () => {
    const report = checkBudgets([timing('/api/trends', 9_999_999, 9_999_999)], BUDGETS);
    expect(report.breaches).toEqual([]);
    expect(report.unbudgeted).toEqual(['/api/trends']);
    expect(report.checks).toEqual([]);
  });

  it('names a budget whose route no longer exists', () => {
    expect(unknownBudgetRoutes(BUDGETS)).toEqual([]);
    expect(
      unknownBudgetRoutes({ ...BUDGETS, routes: { ...BUDGETS.routes, '/api/renamed-away': { files: 1, db: 1 } } }),
    ).toEqual(['/api/renamed-away']);
  });

  it('records medians per route and per backing, keeping the fixture prose and headroom', () => {
    const next = recordBudgets(
      [timing('/api/summary', 10, 30), timing('/api/summary', 20, 40), timing('/api/usage', 5, 5)],
      BUDGETS,
      24,
      new Date('2026-08-16T12:00:00.000Z'),
    );
    expect(next.routes).toEqual({ '/api/summary': { files: 15, db: 35 }, '/api/usage': { files: 5, db: 5 } });
    expect(next.recordedAt).toBe('2026-08-16T12:00:00.000Z');
    expect(next.corpus).toEqual({ archivedDays: 24, note: 'fixture under test' });
    expect(next.headroom).toBe(3);
    expect(next.floorMs).toBe(50);
  });

  it('is on by default, off on request, and recording only when asked', () => {
    expect(budgetsEnabled({})).toBe(true);
    expect(budgetsEnabled({ ROUTE_BUDGETS: '0' })).toBe(false);
    expect(budgetsEnabled({ ROUTE_BUDGETS: 'false' })).toBe(false);
    expect(budgetsRecording({})).toBe(false);
    expect(budgetsRecording({ ROUTE_BUDGETS: 'record' })).toBe(true);
  });

  it('ships a fixture whose every budgeted route is registered and positive', () => {
    const budgets = readRouteBudgets();
    expect(unknownBudgetRoutes(budgets)).toEqual([]);
    expect(budgets.headroom).toBeGreaterThan(1);
    expect(budgets.floorMs).toBeGreaterThan(0);
    expect(Object.keys(budgets.routes).length, 'the fixture records no budget, so it gates nothing').toBeGreaterThan(0);
    for (const [route, budget] of Object.entries(budgets.routes)) {
      expect(budget.files, `${route} files`).toBeGreaterThan(0);
      expect(budget.db, `${route} db`).toBeGreaterThan(0);
    }
    // Every registered route is replayed, so the fixture may not name more than exist.
    expect(Object.keys(budgets.routes).length).toBeLessThanOrEqual(PARITY_ROUTES.length);
  });
});
