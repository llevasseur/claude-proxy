// The hourly collector: a resident timer inside net-server (decision
// internet-spend 005 — no launchd, no second process). Each wake runs
// `nettop -L 1` once, reads the boot epoch, and applies ticket 01's write rules.
// A failed or unparseable batch is skipped whole — no partial batch is written.

import { execFile } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import { parseBootTime, parseNettopCsv } from './nettop.ts';
import { CADENCE_MS, insertDiscontinuity, insertSample, lastSampleBySeries, rebuildUsageDay } from './store.ts';

export const COLLECT_INTERVAL_MS = 3_600_000;

export interface CollectorDeps {
  readonly db: DatabaseSync;
  /** UTC epoch milliseconds stamp for this batch. */
  readonly now: () => number;
  readonly timeZone?: string;
  /** Injectable for tests; defaults to `nettop -L 1`. */
  readonly readNettop?: () => Promise<string>;
  /** Injectable for tests; defaults to `sysctl -n kern.boottime`. */
  readonly readBootTime?: () => Promise<string>;
}

export type CollectResult =
  | { status: 'ok'; timestamp: number; storedSamples: number; discontinuities: number }
  | { status: 'skipped'; reason: string };

function nettopOnce(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('nettop', ['-L', '1'], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

function sysctlBootTime(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('sysctl', ['-n', 'kern.boottime'], (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * One collection batch. Rows are stored per `(name, pid, interface)` whenever
 * their cumulative differs from the previous batch in either direction — a
 * decreased sample MUST be stored or its discontinuity becomes invisible at
 * read time (decision internet-spend 002). Boot changes and decreases also
 * write typed discontinuity rows. The usage_day rollup is refreshed after each
 * successful batch. Nothing is written unless every step succeeds.
 */
export async function collectBatch(deps: CollectorDeps): Promise<CollectResult> {
  let csv: string;
  try {
    csv = await (deps.readNettop ?? nettopOnce)();
  } catch (error) {
    return { status: 'skipped', reason: `nettop failed: ${String(error)}` };
  }

  const rows = parseNettopCsv(csv);
  if (!rows) return { status: 'skipped', reason: 'nettop output was unparseable' };

  let bootRaw: string;
  try {
    bootRaw = await (deps.readBootTime ?? sysctlBootTime)();
  } catch (error) {
    return { status: 'skipped', reason: `sysctl boottime failed: ${String(error)}` };
  }
  const bootEpoch = parseBootTime(bootRaw);
  if (bootEpoch === null) return { status: 'skipped', reason: 'boottime was unparseable' };

  const timestamp = deps.now();
  const previous = lastSampleBySeries(deps.db);

  let storedSamples = 0;
  let discontinuities = 0;
  deps.db.exec('BEGIN');
  try {
    for (const row of rows) {
      const before = previous.get(`${row.name}\u0000${row.pid}\u0000${row.interface}`);
      if (before) {
        const newSum = row.bytesIn + row.bytesOut;
        const oldSum = before.bytes_in + before.bytes_out;
        if (newSum === oldSum && before.boot_epoch === bootEpoch) continue;
        if (before.boot_epoch !== bootEpoch) {
          insertDiscontinuity(deps.db, timestamp, 'boot');
          discontinuities++;
        } else if (newSum < oldSum) {
          insertDiscontinuity(deps.db, timestamp, 'decrease');
          discontinuities++;
        }
      }
      insertSample(deps.db, {
        timestamp,
        bootEpoch,
        name: row.name,
        pid: row.pid,
        interface: row.interface,
        bytesIn: row.bytesIn,
        bytesOut: row.bytesOut,
      });
      storedSamples++;
    }
    rebuildUsageDay(deps.db, deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    deps.db.exec('COMMIT');
  } catch (error) {
    deps.db.exec('ROLLBACK');
    return { status: 'skipped', reason: `batch write failed: ${String(error)}` };
  }
  return { status: 'ok', timestamp, storedSamples, discontinuities };
}

/**
 * The resident hourly timer (decision internet-spend 005): one process, one
 * database, single writer. Runs one batch immediately so a freshly started
 * server has coverage from its first minute, then wakes on the cadence.
 */
export function startCollector(deps: CollectorDeps, options: { intervalMs?: number } = {}): { stop: () => void } {
  const intervalMs = options.intervalMs ?? COLLECT_INTERVAL_MS;
  void collectBatch(deps).catch(() => undefined);
  const timer = setInterval(() => void collectBatch(deps).catch(() => undefined), Math.max(intervalMs, 1));
  return { stop: () => clearInterval(timer) };
}

export { CADENCE_MS };
