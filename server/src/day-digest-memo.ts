import type { UsageDigest } from '@claude-proxy/core';
import type { SidecarSource } from './db/source.js';
import { today } from './logs.js';

/**
 * Per-day digests for days that can no longer change, held for the process
 * lifetime — the shape `usage-history.ts` already uses for the meters.
 *
 * Today is never stored: a digest is only kept for a reporting day strictly
 * earlier than the one `now` falls in, and any day still split across the live
 * directory and the archive is recomputed on every read.
 *
 * The memo is unbounded, like the two it sits beside, and bounded in practice
 * by the number of distinct closed days a process is asked for — one small
 * object per day, growing at most a day per day of uptime.
 */

/**
 * What makes two reads of "the same day" the same. The backing is part of it
 * because the parity harness computes both ways; the classifier hash-set *size*
 * is, because that store only grows and a digest taken before a new revision was
 * recorded would otherwise never be recomputed.
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

/** Whether `date` is a reporting day earlier than the one `now` falls in. */
export function isClosedDay(date: string, now: Date): boolean {
  return date < today(now);
}

/**
 * A held digest for that day, or `undefined`. Never does I/O, so checking it
 * before reading lets a caller skip the day's read entirely.
 */
export function cachedDayDigest(key: DayDigestKey): UsageDigest | undefined {
  return dayDigests.get(keyOf(key));
}

/**
 * Keep `digest` for `key`, if the day is one that can no longer change.
 *
 * `stable` is the caller's answer to "is this day still moving?" — a day the
 * live directory still holds part of is passed as unstable. That, plus the
 * {@link isClosedDay} guard, is how a split day is handled: never keyed at all,
 * rather than keyed on something that would have to be invalidated.
 */
export function cacheDayDigest(key: DayDigestKey, now: Date, digest: UsageDigest, stable: boolean): UsageDigest {
  if (stable && isClosedDay(key.date, now)) dayDigests.set(keyOf(key), digest);
  return digest;
}

/**
 * Read one day's digest through the memo. `compute` runs only on a miss, and
 * its answer is kept only when the day is closed. A `null` is never stored — a
 * day can gain its archive later, and a sticky miss would pin the gap in place.
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
