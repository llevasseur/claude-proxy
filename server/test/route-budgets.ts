import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RouteBudgets } from '../src/parity.js';

/**
 * The recorded per-route time budgets, and how the suite reads and rewrites them.
 *
 * A JSON fixture rather than constants in the test, because these are
 * *measurements* rather than decisions: a `ROUTE_BUDGETS=record` run rewrites
 * the file wholesale, and it reviews as a diff of numbers.
 */

/** Absolute path to the fixture, so a failure message names a file that can be opened. */
export const BUDGET_FILE = fileURLToPath(new URL('./route-budgets.json', import.meta.url));

export function readRouteBudgets(): RouteBudgets {
  // SAFETY: this file is only ever written by `writeRouteBudgets` below (a
  // `ROUTE_BUDGETS=record` run) or hand-edited to match `RouteBudgets`'s shape,
  // so a successful parse of the fixture is always that shape.
  return JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as RouteBudgets;
}

/** Rewrite the fixture, trailing newline and all, so a record pass makes a clean diff. */
export async function writeRouteBudgets(next: RouteBudgets): Promise<void> {
  await writeFile(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
