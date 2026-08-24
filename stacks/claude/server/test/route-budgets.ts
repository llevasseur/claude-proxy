import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { API_ROUTES } from '@agent-proxy/claude-core';
import type { RouteObservation } from '../src/db/route-observation-store.js';

/**
 * How a route's recorded time and size budgets are judged, and how they are recorded.
 *
 * The numbers and the reasoning behind every one of them are inherited unchanged from the
 * gate commit 348f6ab deleted along with the parity harness it rode on. What changed is
 * only where the observations come from: the harness replayed each route against the whole
 * archive, and `server/src/server.ts` now records one observation per served response. So
 * this module judges — it never issues a request, never replays a route, and never reads
 * `logs/archive`.
 *
 * A JSON fixture rather than constants, because these are *measurements* rather than
 * decisions: a `ROUTE_BUDGETS=record` run rewrites the file wholesale, and it reviews as a
 * diff of numbers.
 */

/** One route's recorded cost: the median answer's duration, and the largest answer's size. */
export interface RouteBudget {
  /**
   * The median served duration, in milliseconds.
   *
   * Median rather than mean or max, because one response in several hundred reliably
   * catches a GC pause — a mean carries that outlier into the number and a max *is* the
   * outlier. A route that genuinely regressed moves every response, which moves the median.
   */
  ms: number;
  /**
   * The largest answer the route served, in bytes.
   *
   * Max rather than the median the duration takes. A duration carries measurement noise the
   * median exists to reject; a serialized length carries none, so there is no outlier to
   * discard, and the case worth gating on is the biggest answer a route hands back — which
   * a median over many small answers hides. `/api/sessions/graph` built in 152.9ms, well
   * inside its time budget, and returned 28.2MB.
   */
  bytes: number;
}

/** The recorded fixture: what was measured, against what, and with how much slack. */
export interface RouteBudgets {
  /** When the numbers below were taken, so a stale fixture is legible as stale. */
  recordedAt: string;
  /** What they were taken over — the traffic a record pass found, not a corpus size. */
  corpus: { observations: number; note: string };
  /**
   * What a recorded number may be multiplied by before it counts as a breach.
   *
   * Three, and it is picked against the recorded spread rather than by taste: consecutive
   * passes over one unchanged corpus have varied by 29% (`/api/summary` 1.52s then 1.18s)
   * and 20% (`/api/usage` 3.13s then 3.77s), so a machine under load plausibly doubles a
   * number without anything having regressed. The failure this exists to catch is
   * sevenfold. Three sits clear of the noise and well under the signal.
   *
   * Shared by both units because it is a ratio, and a ratio has no unit to convert.
   */
  headroom: number;
  /**
   * The smallest time allowance any route gets, in milliseconds, whatever it measured.
   *
   * Headroom is proportional and the jitter it is calibrated against is not. Two routes in
   * the original fixture answered in **0.1ms** — they read one already-loaded object — and
   * x3 on that is an allowance of 0.3ms, which a single scheduler hiccup crosses while
   * nothing whatsoever has regressed. Above ~17ms the floor never binds, because x3 is
   * already larger. Fifty milliseconds sits above scheduling noise and below any duration a
   * human would call slow.
   */
  floorMs: number;
  /**
   * The smallest size allowance any route gets, in bytes, whatever it measured.
   *
   * The same argument {@link RouteBudgets.floorMs} makes, in the other unit, and a separate
   * number because milliseconds and bytes do not convert. A route answering `{"ok":true}`
   * records 11 bytes, and x3 on that is 33: one added field breaches it while nothing has
   * grown in any sense a reader would recognise. 64 KiB sits above every route here that
   * returns a single object and below any response size worth a build failure, and never
   * binds on anything large, since x3 of anything over ~21 KiB already exceeds it.
   */
  floorBytes: number;
  /**
   * Per-route recorded numbers. A route absent from this map is *unbudgeted*, which is
   * reported and never failed: a newly declared route has nothing recorded yet, and failing
   * the build for that would make adding a route require a measurement pass first.
   */
  routes: Record<string, RouteBudget>;
}

/**
 * How many observations a route needs before its median is treated as evidence.
 *
 * The median is chosen for outlier rejection — {@link RouteBudget.ms} justifies it by "one
 * response in several hundred reliably catches a GC pause". That argument needs samples to
 * reject an outlier *with*. At one observation the median **is** the sample, so a single
 * cold-start request becomes the route's measured cost; at two it is their mean, which is
 * the mean the median exists to avoid. Five is the smallest count that leaves two samples
 * either side of the middle one, which is the property the median was picked for.
 *
 * This is not slack on top of an allowance, and it moves no recorded number: `headroom`,
 * both floors and every per-route measurement are untouched. It decides only *whether a
 * route has enough evidence to be judged at all* — the rule the report already applies at
 * zero observations, held consistently above zero. A route below the threshold is named in
 * {@link BudgetReport.insufficient} and judged as soon as it has the samples.
 *
 * The time half only. A max over sizes needs no such threshold: {@link RouteBudget.bytes}
 * records that a serialized length carries no measurement noise, so one large answer is a
 * real large answer and there is no outlier to out-vote.
 */
export const MINIMUM_OBSERVATIONS = 5;

/** One route's median duration judged against its time budget. */
export interface BudgetCheck {
  route: string;
  observations: number;
  medianMs: number;
  budgetMs: number;
  allowedMs: number;
  /**
   * Whether the median was treated as evidence at all — see {@link MINIMUM_OBSERVATIONS}.
   * A route below the threshold still reports its numbers, so the count it is short by is
   * visible rather than merely absent.
   */
  judged: boolean;
  over: boolean;
}

/** One route's largest answer judged against its size budget. */
export interface SizeCheck {
  route: string;
  observations: number;
  bytes: number;
  budgetBytes: number;
  allowedBytes: number;
  over: boolean;
}

export interface BudgetReport {
  checks: BudgetCheck[];
  sizes: SizeCheck[];
  /** Breach lines, empty when every budgeted route with traffic was inside its allowance. */
  breaches: string[];
  /** Routes that were served but carry no recorded budget. Reported, never failed. */
  unbudgeted: string[];
  /**
   * Budgeted routes with no observations at all. Reported, never failed — a clean clone has
   * no database, and a route nobody opened this week has nothing to judge.
   */
  unobserved: string[];
  /**
   * Routes with some traffic but fewer than {@link MINIMUM_OBSERVATIONS} of it, whose time
   * half was therefore not judged. Reported, never failed, and distinct from
   * {@link BudgetReport.unobserved} because the answer to it is different: an unobserved
   * route was never opened, whereas one of these was opened too few times for its median to
   * mean anything yet. Their size half is judged as normal.
   */
  insufficient: string[];
}

/** The middle value of a set of durations. See {@link RouteBudget.ms} for why a median. */
export function medianMs(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The largest value in a set of sizes. See {@link RouteBudget.bytes} for why a max. */
export function maxBytes(values: number[]): number {
  return values.reduce((hi, v) => (v > hi ? v : hi), 0);
}

/** A size in the unit a human would state it in. */
function statedBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** Observations grouped by route, in the order they were recorded. */
function byRoute(observations: RouteObservation[]): Map<string, { ms: number[]; bytes: number[] }> {
  const out = new Map<string, { ms: number[]; bytes: number[] }>();
  for (const o of observations) {
    const entry = out.get(o.route) ?? { ms: [], bytes: [] };
    entry.ms.push(o.durationMs);
    entry.bytes.push(o.bytes);
    out.set(o.route, entry);
  }
  return out;
}

/** Judge real served observations against the recorded fixture. */
export function checkBudgets(observations: RouteObservation[], budgets: RouteBudgets): BudgetReport {
  const checks: BudgetCheck[] = [];
  const sizes: SizeCheck[] = [];
  const breaches: string[] = [];
  const unbudgeted: string[] = [];
  const insufficient: string[] = [];
  const grouped = byRoute(observations);

  for (const [route, seen] of grouped) {
    const budget = budgets.routes[route];
    if (!budget) {
      unbudgeted.push(route);
      continue;
    }

    const observedMs = medianMs(seen.ms);
    const allowedMs = Math.max(budget.ms * budgets.headroom, budgets.floorMs);
    // Too few samples for the median to reject anything, so this route's time half is
    // reported rather than judged. See `MINIMUM_OBSERVATIONS`.
    const judged = seen.ms.length >= MINIMUM_OBSERVATIONS;
    if (!judged) insufficient.push(route);
    const overMs = judged && observedMs > allowedMs;
    checks.push({
      route,
      observations: seen.ms.length,
      medianMs: observedMs,
      budgetMs: budget.ms,
      allowedMs,
      judged,
      over: overMs,
    });
    if (overMs) {
      breaches.push(
        `${route} (time) median ${observedMs.toFixed(0)}ms over ${seen.ms.length} observations ` +
          `exceeds its allowance of ${allowedMs.toFixed(0)}ms ` +
          `(recorded ${budget.ms.toFixed(0)}ms x${budgets.headroom}, floor ${budgets.floorMs}ms)`,
      );
    }

    const observedBytes = maxBytes(seen.bytes);
    const allowedBytes = Math.max(budget.bytes * budgets.headroom, budgets.floorBytes);
    const overBytes = observedBytes > allowedBytes;
    sizes.push({
      route,
      observations: seen.bytes.length,
      bytes: observedBytes,
      budgetBytes: budget.bytes,
      allowedBytes,
      over: overBytes,
    });
    if (overBytes) {
      breaches.push(
        `${route} (size) largest answer ${statedBytes(observedBytes)} over ${seen.bytes.length} observations ` +
          `exceeds its allowance of ${statedBytes(allowedBytes)} ` +
          `(recorded ${statedBytes(budget.bytes)} x${budgets.headroom}, floor ${statedBytes(budgets.floorBytes)})`,
      );
    }
  }

  const unobserved = Object.keys(budgets.routes)
    .filter((route) => !grouped.has(route))
    .sort();

  return {
    checks,
    sizes,
    breaches: breaches.sort(),
    unbudgeted: unbudgeted.sort(),
    unobserved,
    insufficient: insufficient.sort(),
  };
}

/**
 * Budgeted route names that no longer name a declared route.
 *
 * A rename would otherwise silently un-budget a route: the old key stops matching, the new
 * name reads as merely unbudgeted, and the gate goes quiet on exactly the route someone was
 * just editing. Judged against `API_ROUTES`, which is the registry the server dispatches on.
 */
export function unknownBudgetRoutes(budgets: RouteBudgets): string[] {
  const declared = new Set<string>(API_ROUTES.map((route) => route.path));
  return Object.keys(budgets.routes)
    .filter((route) => !declared.has(route))
    .sort();
}

/**
 * Whether this run rewrites the fixture instead of judging against it.
 *
 * The only environment switch this gate carries. The old `ROUTE_BUDGETS=0` escape hatch is
 * deliberately not restored: it existed because the gate rode a twenty-minute replay that
 * could fail on a busy machine, and this gate reads a table in milliseconds and fails
 * nothing it has no observations for.
 */
export function budgetsRecording(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROUTE_BUDGETS === 'record';
}

/**
 * Budgeted routes this record pass saw no traffic for, and so cannot re-measure.
 *
 * Their recorded numbers are carried through unchanged by {@link recordBudgets}, and named
 * here so the pass can say which of its numbers are new and which are inherited.
 */
export function carriedRoutes(observations: RouteObservation[], previous: RouteBudgets): string[] {
  const measured = byRoute(observations);
  return Object.keys(previous.routes)
    .filter((route) => !measured.has(route))
    .sort();
}

/**
 * Build the fixture a record pass writes out.
 *
 * Budgets are measurements, not targets: a legitimate slowdown ships its new numbers as a
 * reviewable diff rather than being argued about. The prose and both floors carry over from
 * the previous fixture — a record pass re-measures, it does not re-decide.
 *
 * **A route the pass saw no traffic for keeps the numbers it already had.** Rebuilding the
 * map from the observations alone would drop it, and a dropped route reads as *unbudgeted*,
 * which is reported and never failed — so recording on a device that exercised only the
 * usage pages would quietly un-budget everything else, which is what
 * {@link unknownBudgetRoutes} exists to stop a rename doing. {@link carriedRoutes} names
 * the ones carried.
 */
export function recordBudgets(observations: RouteObservation[], previous: RouteBudgets, at: Date): RouteBudgets {
  const routes: Record<string, RouteBudget> = {};
  const measured = byRoute(observations);
  const names = [...new Set([...Object.keys(previous.routes), ...measured.keys()])].sort((a, b) => a.localeCompare(b));
  for (const route of names) {
    const seen = measured.get(route);
    // SAFETY: `names` is the union of both maps' keys, so a route absent from `measured` is
    // a key of `previous.routes`.
    routes[route] = seen
      ? { ms: Number(medianMs(seen.ms).toFixed(1)), bytes: maxBytes(seen.bytes) }
      : previous.routes[route]!;
  }
  return {
    recordedAt: at.toISOString(),
    corpus: { observations: observations.length, note: previous.corpus.note },
    headroom: previous.headroom,
    floorMs: previous.floorMs,
    floorBytes: previous.floorBytes,
    routes,
  };
}

/** Absolute path to the fixture, so a failure message names a file that can be opened. */
export const BUDGET_FILE = fileURLToPath(new URL('./route-budgets.json', import.meta.url));

export function readRouteBudgets(): RouteBudgets {
  // SAFETY: this file is only ever written by `writeRouteBudgets` below (a record pass) or
  // hand-edited to match `RouteBudgets`'s shape, so a successful parse is always that shape.
  return JSON.parse(readFileSync(BUDGET_FILE, 'utf8')) as RouteBudgets;
}

/** Rewrite the fixture, trailing newline and all, so a record pass makes a clean diff. */
export async function writeRouteBudgets(next: RouteBudgets): Promise<void> {
  await writeFile(BUDGET_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
