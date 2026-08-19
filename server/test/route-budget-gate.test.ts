import { afterAll, describe, expect, it } from 'vitest';
import { closeRouteObservations, readRouteObservations } from '../src/db/route-observation-store.js';
import { resolveLogDir } from '../src/logs.js';
import {
  BUDGET_FILE,
  budgetsRecording,
  carriedRoutes,
  checkBudgets,
  readRouteBudgets,
  recordBudgets,
  unknownBudgetRoutes,
  writeRouteBudgets,
} from './route-budgets.js';

/**
 * The route budget gate: does any route now answer far slower, or far larger, than the
 * recorded fixture says it used to.
 *
 * **It issues no request and replays no route.** `server/src/server.ts` records one
 * observation per served response into `route_observation`, so by the time this runs the
 * measurement already happened — this reads a table and judges it, which is why it costs
 * milliseconds where the parity harness it replaces cost twenty minutes. Nothing here
 * touches `logs/archive`, and the read is read-only, so a run neither migrates a
 * developer's database nor creates one.
 *
 * Two failure modes are deliberately not failures. A route with **no observations** is
 * reported: a clean clone has no database at all, and a route nobody opened this week has
 * nothing to judge. A **served route with no budget** is reported too, so declaring a route
 * does not require a measurement pass first. What does fail is a breach, and a fixture entry
 * naming a route that no longer exists — otherwise a rename silently un-budgets the route
 * someone was just editing.
 *
 * Budgets are measurements, not targets. `ROUTE_BUDGETS=record pnpm --filter server test`
 * rewrites the fixture from whatever traffic the substrate holds, so a legitimate slowdown
 * ships its new numbers as a reviewable diff.
 */

const LOG_DIR = resolveLogDir();
const observations = readRouteObservations(LOG_DIR);
const budgets = readRouteBudgets();

afterAll(() => {
  closeRouteObservations();
});

if (budgetsRecording()) {
  describe('recording route budgets from served traffic', () => {
    it('rewrites the fixture from the observations the substrate holds', async () => {
      expect(
        observations.length,
        `no served observations in ${LOG_DIR} — start the server, exercise the routes, then record`,
      ).toBeGreaterThan(0);
      const carried = carriedRoutes(observations, budgets);
      const next = recordBudgets(observations, budgets, new Date());
      await writeRouteBudgets(next);
      console.log(
        `[route-budgets] recorded ${Object.keys(next.routes).length - carried.length} routes ` +
          `from ${observations.length} observations into ${BUDGET_FILE}`,
      );
      // Named rather than dropped: this pass saw no traffic for them, so they keep the
      // numbers they had. A device that exercised only part of the dashboard should not
      // silently un-budget the rest.
      if (carried.length) {
        console.log(`[route-budgets] carried ${carried.length} unexercised routes unchanged: ${carried.join(', ')}`);
      }
    });
  });
} else {
  describe('route budgets, judged against served traffic', () => {
    it('names no budget whose route no longer exists', () => {
      expect(
        unknownBudgetRoutes(budgets),
        'a renamed route would otherwise read as merely unbudgeted, and the gate would go quiet on it',
      ).toEqual([]);
    });

    it('answers every budgeted route inside its recorded time and size allowance', () => {
      const report = checkBudgets(observations, budgets);

      // Reported, never failed — see the module comment.
      if (report.unobserved.length) {
        console.log(`[route-budgets] no observations for ${report.unobserved.length}: ${report.unobserved.join(', ')}`);
      }
      if (report.unbudgeted.length) {
        console.log(`[route-budgets] served but unbudgeted: ${report.unbudgeted.join(', ')}`);
      }

      expect(report.breaches, `re-record with ROUTE_BUDGETS=record if these numbers are the new truth`).toEqual([]);
    });
  });
}
