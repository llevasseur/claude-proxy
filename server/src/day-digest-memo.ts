import type { UsageDigest } from '@claude-proxy/core';
import type { SidecarSource } from './db/source.js';
import { today } from './logs.js';

/**
 * Per-day digests for days that can no longer change, held for the process
 * lifetime.
 *
 * `/api/summary/stream` and the Trends page both rebuild on a 600ms debounce
 * against a watch on the log directory, and both walk back through the same
 * fortnight of finished days on every tick. Those days are immutable, so the
 * walk recomputes an identical answer each time. This is the same argument
 * `usage-history.ts` already makes for the meters — "cached rather than run per
 * request", because re-reading thousands of sidecar files per tick is not
 * affordable — carried to the two pages the Overview actually renders, and this
 * module deliberately mirrors that file's shape.
 *
 * **Today is never stored.** A digest is only ever kept for a reporting day
 * strictly earlier than the one `now` falls in; the day in progress is
 * recomputed on every read, as is any day still split across the live directory
 * and the archive (see {@link isClosedDay} and the callers in `api.ts`).
 *
 * The memo is **unbounded**, like the two it sits beside (`usage-history.ts`'s
 * `dayCache` and the raw-archive digests this module now backs). It is bounded
 * in practice by the number of distinct closed days a process is asked for:
 * one small object per day per (backing, log dir, archive dir, classifier
 * revision count), growing at most one day per day of uptime. A server up for a
 * year holds a few hundred of them. An eviction policy would buy nothing and
 * would risk dropping the entry the next tick is about to ask for.
 */

/**
 * What makes two reads of "the same day" the same.
 *
 * The backing is part of it because the parity harness computes both ways and a
 * shared entry would hand the second run the first one's answer. `archiveDir`
 * is part of it because it decides which roots the day was read from. The
 * classifier hash-set *size* is part of it because that store only grows — a
 * digest computed before a new classifier revision was recorded would otherwise
 * never be recomputed.
 */
export interface DayDigestKey {
  logDir: string;
  date: string;
  source: SidecarSource;
  classifierHashes: ReadonlySet<string>;
  archiveDir?: string;
}

const dayDigests = new Map<string, UsageDigest>();

/** Test-only, and for anything that rewrites the archive: drop the memo. */
export function clearDayDigestMemo(): void {
  dayDigests.clear();
}

function keyOf(key: DayDigestKey): string {
  return `${key.source.kind} ${key.logDir} ${key.archiveDir ?? ''} ${key.date} ${key.classifierHashes.size}`;
}

/**
 * Whether `date` is a reporting day that has finished — the one guard that
 * keeps the day in progress out of the memo. `today(now)` is the reporting day
 * `now` falls in, and day labels sort lexicographically.
 */
export function isClosedDay(date: string, now: Date): boolean {
  return date < today(now);
}

/**
 * A held digest for that day, or `undefined`. Never does I/O — checking this
 * *before* reading is the whole point, since a hit lets the caller skip both
 * halves of the day's read rather than just the digest arithmetic.
 */
export function cachedDayDigest(key: DayDigestKey): UsageDigest | undefined {
  return dayDigests.get(keyOf(key));
}

/**
 * Keep `digest` for `key`, if the day is one that can no longer change.
 *
 * `stable` is the caller's answer to "is this day still moving?" — a reporting
 * day the live directory still holds part of has more to come once the archiver
 * rotates it, so it is passed as unstable and recomputed on every read. That,
 * plus the {@link isClosedDay} guard, is how a split day is handled: it is never
 * keyed at all rather than keyed on something that would have to be invalidated.
 */
export function cacheDayDigest(key: DayDigestKey, now: Date, digest: UsageDigest, stable: boolean): UsageDigest {
  if (stable && isClosedDay(key.date, now)) dayDigests.set(keyOf(key), digest);
  return digest;
}

/**
 * Read one day's digest through the memo. `compute` runs only on a miss, and
 * its answer is kept only when the day is closed.
 *
 * A `null` from `compute` is never stored: a day can gain its archive later,
 * and a sticky miss would pin the gap in place until restart.
 */
export async function memoisedDayDigest(
  key: DayDigestKey,
  now: Date,
  compute: () => Promise<UsageDigest | null>,
): Promise<UsageDigest | null> {
  const hit = cachedDayDigest(key);
  if (hit) return hit;
  const digest = await compute();
  return digest === null ? null : cacheDayDigest(key, now, digest, true);
}
