import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openDb, openDbReadOnly, resolveDbPath } from './open.js';

/**
 * What the routes actually cost when they answered, one row per served response.
 *
 * The deleted parity harness measured this by replaying every wired route
 * against the whole archive, which is why it took twenty minutes and only ran on
 * the one device that had an archive. Nothing about a *budget* needs a replay:
 * the server already builds each answer and already knows how long it took, so
 * the measurement is a by-product of traffic that happened anyway.
 *
 * Two consequences shape everything below. The write sits on the request path, so
 * it costs an insert of four small integers and nothing else. And the rows are
 * disposable: a missing database, a locked one, or a failed insert all read as
 * "no observation", which the gate reports rather than fails.
 */

/** One served response, as the budget gate judges it. */
export interface RouteObservation {
  /** The declared route's pathname — `ApiRoute['path']`, the key a budget is recorded under. */
  route: string;
  /** Wall-clock milliseconds from dispatch to the response being served, rounded. */
  durationMs: number;
  /** `Buffer.byteLength` of the JSON body that went out, before any gzip. */
  bytes: number;
}

/**
 * How many observations each route keeps.
 *
 * The gate takes a median over durations and a max over sizes, and both settle
 * long before two hundred samples — the deleted fixture's medians came from 436
 * cases spread over 29 routes. A cap rather than a time window because the
 * quantity being defended is bounded table size, and a busy hour and a quiet
 * week should leave the same footprint. Two hundred rows per route is well under
 * a megabyte across every route the server declares.
 */
export const OBSERVATIONS_PER_ROUTE = 200;

/**
 * How many inserts pass before the cap is enforced.
 *
 * Pruning on every insert would put a window function on the request path for no
 * gain; the cap is about long-run growth, so overshooting it by at most this many
 * rows between passes is free.
 */
const PRUNE_EVERY = 100;

const INSERT = `
INSERT INTO route_observation (route, observed_at, duration_ms, bytes)
VALUES (?, ?, ?, ?)
`;

/**
 * Drop everything past the newest {@link OBSERVATIONS_PER_ROUTE} of each route.
 *
 * A window function partitioned by route rather than a correlated subquery: the
 * latter re-runs per candidate row and turns the prune quadratic.
 */
const PRUNE = `
DELETE FROM route_observation WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY route ORDER BY id DESC) AS rn
    FROM route_observation
  ) WHERE rn > ?
)
`;

const SELECT_ALL = `
SELECT route, duration_ms, bytes FROM route_observation ORDER BY route, id
`;

/** One writable connection per log directory, opened on first use. */
const handles = new Map<string, DatabaseSync>();

/** One read-only connection per log directory, for {@link readRouteObservations}. */
const readers = new Map<string, DatabaseSync>();

/** Inserts since this process last enforced the cap, per log directory. */
const sincePrune = new Map<string, number>();

/**
 * The substrate for `logDir`, or `null` when there is none.
 *
 * The file is never *created* here, for the reason `usage-day-store.ts` gives:
 * an observation must not leave a database behind in a log directory that had
 * none. A negative answer is not remembered, so a server whose substrate opens
 * after the first response starts recording from the second.
 *
 * `busy_timeout` is the one pragma this handle adds, and it is deliberately
 * short. The ingest watcher writes to the same file and WAL admits one writer at
 * a time, so without any timeout a response landing mid-ingest loses its
 * observation to `SQLITE_BUSY`. But `DatabaseSync` blocks, and this runs from the
 * server's `finish` handler on the main thread — the wait costs the response
 * being measured nothing, since it has already gone out, and costs every *other*
 * in-flight request the whole time it lasts. A long timeout would trade a stalled
 * event loop for a sample the gate does not need: it judges a median over
 * hundreds, and losing the handful that collide with an ingest pass changes no
 * verdict.
 */
function handleFor(logDir: string): DatabaseSync | null {
  const held = handles.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDb(logDir);
    db.exec('PRAGMA busy_timeout = 25');
    handles.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * A **read-only** handle on the substrate for `logDir`, or `null` when there is none.
 *
 * Read-only rather than the writer above, because the only reader is the budget gate and a
 * test must not migrate a developer's database or leave one behind. On a database the
 * schema step has not reached, `route_observation` does not exist and the select throws,
 * which {@link readRouteObservations} already reads as "nothing recorded".
 */
function readerFor(logDir: string): DatabaseSync | null {
  const held = readers.get(logDir);
  if (held) return held;
  if (!existsSync(resolveDbPath(logDir))) return null;
  try {
    const db = openDbReadOnly(logDir);
    readers.set(logDir, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * Append one observation. Best-effort in every direction — a failure here must
 * never disturb a response that has already gone out.
 */
export function recordRouteObservation(logDir: string, observation: RouteObservation): void {
  const db = handleFor(logDir);
  if (!db) return;
  try {
    db.prepare(INSERT).run(
      observation.route,
      new Date().toISOString(),
      Math.round(observation.durationMs),
      Math.round(observation.bytes),
    );
    const n = (sincePrune.get(logDir) ?? 0) + 1;
    if (n < PRUNE_EVERY) {
      sincePrune.set(logDir, n);
      return;
    }
    sincePrune.set(logDir, 0);
    db.prepare(PRUNE).run(OBSERVATIONS_PER_ROUTE);
  } catch {
    // A locked or unwritable view loses the sample and nothing else.
  }
}

/**
 * Every observation the substrate holds, oldest first within each route.
 *
 * An absent database, an unmigrated one, or an unreadable one all answer with an
 * empty list, which the gate reports as "no observations" for every route rather
 * than failing. That is what makes the gate safe on a clean clone and in CI.
 */
export function readRouteObservations(logDir: string): RouteObservation[] {
  const db = readerFor(logDir);
  if (!db) return [];
  try {
    // SAFETY: `SELECT_ALL` names exactly these three columns, and the table declares
    // all three NOT NULL, so every row carries them.
    const rows = db.prepare(SELECT_ALL).all() as { route: string; duration_ms: number; bytes: number }[];
    return rows.map((row) => ({ route: row.route, durationMs: row.duration_ms, bytes: row.bytes }));
  } catch {
    return [];
  }
}

/** Enforce the per-route cap now, rather than at the next {@link PRUNE_EVERY} boundary. */
export function pruneRouteObservations(logDir: string): void {
  const db = handleFor(logDir);
  if (!db) return;
  try {
    db.prepare(PRUNE).run(OBSERVATIONS_PER_ROUTE);
  } catch {
    // Same bargain as the insert: the cap is enforced on some later pass instead.
  }
}

/** Release the handles this module opened — for tests and orderly shutdown. */
export function closeRouteObservations(): void {
  for (const db of [...handles.values(), ...readers.values()]) {
    try {
      db.close();
    } catch {
      // Already closed, or closed underneath us. Either way there is nothing to release.
    }
  }
  handles.clear();
  readers.clear();
  sincePrune.clear();
}
