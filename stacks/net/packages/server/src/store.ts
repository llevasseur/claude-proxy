// SQLite access shared by the collector's write path and the HTTP read path.
// Everything above the raw rows is rebuildable state (decision internet-spend
// 003): the sample table is the only durable truth this package keeps.

import type { DatabaseSync } from 'node:sqlite';
import { isJsonString } from './json.ts';
import { bucketDays, classifyIntervals, computeDeltas, DEFAULT_AGENT_PATTERNS, filterInterfaces } from './model.ts';

/** The sampling cadence the collector runs at; gap classification keys off 3x it. */
export const CADENCE_MS = 3_600_000;

// An object type rather than an interface, so its implicit index signature keeps
// it comparable to the `Record<string, …>` row shape node:sqlite returns.
export type SampleRow = {
  readonly timestamp: number;
  readonly boot_epoch: number;
  readonly name: string;
  readonly pid: number;
  readonly interface: string;
  readonly bytes_in: number;
  readonly bytes_out: number;
};

function queryRows(db: DatabaseSync, sql: string): SampleRow[] {
  // SAFETY: every caller below passes a SELECT naming exactly the seven
  // SampleRow columns, each declared NOT NULL by migration 001.
  return db.prepare(sql).all() as SampleRow[];
}

/** Every stored sample ordered into per-series delta order. */
export function loadSamples(db: DatabaseSync): SampleRow[] {
  return queryRows(
    db,
    'SELECT timestamp, boot_epoch, name, pid, interface, bytes_in, bytes_out FROM sample ORDER BY timestamp',
  );
}

/**
 * The latest stored cumulative for each `(name, pid, interface)` series — the
 * write-time baseline. Read fresh from the database rather than cached in the
 * collector so writer and reader agree by construction.
 */
export function lastSampleBySeries(db: DatabaseSync): Map<string, SampleRow> {
  const rows = queryRows(
    db,
    `SELECT s.timestamp, s.boot_epoch, s.name, s.pid, s.interface, s.bytes_in, s.bytes_out
     FROM sample s
     JOIN (SELECT name, pid, interface, MAX(timestamp) AS mt FROM sample GROUP BY name, pid, interface) last
       ON s.name = last.name AND s.pid = last.pid AND s.interface = last.interface AND s.timestamp = last.mt`,
  );
  const bySeries = new Map<string, SampleRow>();
  for (const row of rows) bySeries.set(seriesKey(row.name, row.pid, row.interface), row);
  return bySeries;
}

export function seriesKey(name: string, pid: number, iface: string): string {
  return `${name}\u0000${pid}\u0000${iface}`;
}

/** Group ordered samples into per-`(name, pid, interface)` series lists. */
export function groupIntoSeries(samples: readonly SampleRow[]): Map<string, SampleRow[]> {
  const grouped = new Map<string, SampleRow[]>();
  for (const sample of samples) {
    const key = seriesKey(sample.name, sample.pid, sample.interface);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(sample);
    else grouped.set(key, [sample]);
  }
  return grouped;
}

export function insertSample(
  db: DatabaseSync,
  row: {
    timestamp: number;
    bootEpoch: number;
    name: string;
    pid: number;
    interface: string;
    bytesIn: number;
    bytesOut: number;
  },
): void {
  db.prepare(
    'INSERT INTO sample (timestamp, boot_epoch, name, pid, interface, bytes_in, bytes_out) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(row.timestamp, row.bootEpoch, row.name, row.pid, row.interface, row.bytesIn, row.bytesOut);
}

export function insertDiscontinuity(db: DatabaseSync, timestamp: number, kind: 'boot' | 'decrease'): void {
  db.prepare('INSERT INTO discontinuity (timestamp, kind) VALUES (?, ?)').run(timestamp, kind);
}

export interface NetConfig {
  limitBytes: number | null;
  resetDay: number | null;
  agentPatterns: string[];
}

/** One row of the key/value config table. An object type for the same reason `SampleRow` is. */
type ConfigRow = {
  readonly key: string;
  readonly value: string;
};

export const DEFAULT_NET_CONFIG: NetConfig = {
  limitBytes: null,
  resetDay: null,
  agentPatterns: [...DEFAULT_AGENT_PATTERNS],
};

export function readNetConfig(db: DatabaseSync): NetConfig {
  const config: NetConfig = {
    limitBytes: DEFAULT_NET_CONFIG.limitBytes,
    resetDay: DEFAULT_NET_CONFIG.resetDay,
    agentPatterns: [...DEFAULT_NET_CONFIG.agentPatterns],
  };
  // SAFETY: the SELECT names exactly `key` and `value`, both NOT NULL TEXT
  // columns of the config table created by migration 001.
  const rows = db.prepare('SELECT key, value FROM config').all() as ConfigRow[];
  for (const row of rows) {
    if (row.key === 'limitBytes' || row.key === 'resetDay') {
      const parsed = Number(row.value);
      if (Number.isSafeInteger(parsed)) config[row.key] = parsed;
    } else if (row.key === 'agentPatterns') {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (Array.isArray(parsed) && parsed.every((entry) => isJsonString(entry) && entry.length > 0)) {
          config.agentPatterns = parsed;
        }
      } catch {
        // A corrupt cell falls back to the default list rather than throwing.
      }
    }
  }
  return config;
}

export function writeNetConfigValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function clearNetConfigValue(db: DatabaseSync, key: string): void {
  db.prepare('DELETE FROM config WHERE key = ?').run(key);
}

/**
 * The read-time spend model over the stored corpus: wire-byte filtering
 * (decision internet-spend 001), then one delta rule per series and gap
 * classification against the sampling cadence (decision internet-spend 002).
 * The collector's write path and every route read through this one function so
 * they cannot disagree.
 */
export interface CorpusClassification {
  intervals: ReturnType<typeof classifyIntervals>;
  sampleCount: number;
}

export function classifyCorpus(db: DatabaseSync): CorpusClassification {
  const samples = loadSamples(db);
  const wire = filterInterfaces(samples.map((sample) => ({ ...sample, interface: sample.interface })));
  const intervals = [];
  const grouped = new Map<string, SampleRow[]>();
  for (const sample of wire) {
    const key = seriesKey(sample.name, sample.pid, sample.interface);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(sample);
    else grouped.set(key, [sample]);
  }
  for (const rows of grouped.values()) {
    const series = rows.map((row) => ({
      timestamp: row.timestamp,
      bootEpoch: row.boot_epoch,
      name: row.name,
      pid: row.pid,
      interface: row.interface,
      bytesIn: row.bytes_in,
      bytesOut: row.bytes_out,
    }));
    intervals.push(...classifyIntervals(computeDeltas(series), { cadenceMs: CADENCE_MS }));
  }
  return { intervals, sampleCount: wire.length };
}

/**
 * Rebuild the rebuildable `usage_day` rollup from raw rows (decision
 * internet-spend 003). The rollup inherits whatever bucketing is current and is
 * never trusted at read time.
 */
export function rebuildUsageDay(db: DatabaseSync, timeZone: string): number {
  const dayBucketing = bucketDays(classifyCorpus(db).intervals, { timeZone });
  db.exec('DELETE FROM usage_day');
  const statement = db.prepare('INSERT INTO usage_day (date, bytes_in, bytes_out, partial) VALUES (?, ?, ?, ?)');
  let written = 0;
  for (const day of dayBucketing.days) {
    statement.run(day.date, day.bytesIn, day.bytesOut, day.partial ? 1 : 0);
    written++;
  }
  return written;
}
