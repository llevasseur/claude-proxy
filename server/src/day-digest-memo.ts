import type { UsageDigest } from '@claude-proxy/core';
import {
  clearStoredDayDigests,
  readStoredDayDigest,
  type StoredDayDigestKey,
  storeDayDigest,
} from './db/day-digest-store.js';
import type { SidecarSource } from './db/source.js';
import { today } from './logs.js';

/**
 * Per-day digests for days that can no longer change, in two levels: this map,
 * held for the process lifetime — the shape `usage-history.ts` already uses for
 * the meters — over a row per day in `day_digest`, which outlives the process.
 *
 * The second level is what makes a *cold* read cheap. A map only helps the second
 * read and later, so a restarted server used to pay the full corpus scan again for
 * the first load of every window route; `db/day-digest-store.ts` answers that one
 * from a row an earlier process wrote. Both levels are caches — a miss at each
 * still computes from the same path as before.
 *
 * Today is never stored at either level: a digest is only kept for a reporting day
 * strictly earlier than the one `now` falls in, and any day still split across the
 * live directory and the archive is recomputed on every read.
 *
 * The map is unbounded, like the two it sits beside, and bounded in practice
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

/**
 * Test-only, and for anything that rewrites the archive: drop the memo.
 *
 * Both levels by default. `keepPersisted` drops only the in-process map, which is
 * how a test spells "restart the server" — the rows stay, and a fresh process
 * finds them.
 */
export function clearDayDigestMemo(opts: { keepPersisted?: boolean } = {}): void {
  dayDigests.clear();
  if (!opts.keepPersisted) clearStoredDayDigests();
}

function keyOf(key: DayDigestKey): string {
  return `${key.source.kind} ${key.logDir} ${key.archiveDir ?? ''} ${key.date} ${key.classifierHashes.size}`;
}

/** The same components as {@link keyOf}, as the persisted row's key. */
function storedKeyOf(key: DayDigestKey): StoredDayDigestKey {
  return {
    backing: key.source.kind,
    logDir: key.logDir,
    archiveDir: key.archiveDir ?? '',
    date: key.date,
    classifierCount: key.classifierHashes.size,
  };
}

/** Whether `date` is a reporting day earlier than the one `now` falls in. */
export function isClosedDay(date: string, now: Date): boolean {
  return date < today(now);
}

/**
 * A held digest for that day, or `undefined` — the in-process map first, then the
 * row an earlier process left. A hit at either level costs no corpus read, which
 * is why a caller checks this before reading the day at all; a level-two hit is
 * promoted into the map, so the row is read at most once per process per day.
 */
export function cachedDayDigest(key: DayDigestKey): UsageDigest | undefined {
  const memoKey = keyOf(key);
  const held = dayDigests.get(memoKey);
  if (held) return held;
  const stored = readStoredDayDigest(storedKeyOf(key));
  if (stored) dayDigests.set(memoKey, stored);
  return stored;
}

/**
 * Keep `digest` for `key`, if the day is one that can no longer change.
 *
 * `stable` is the caller's answer to "is this day still moving?" — a day the
 * live directory still holds part of is passed as unstable. That, plus the
 * {@link isClosedDay} guard, is how a split day is handled: never keyed at all,
 * rather than keyed on something that would have to be invalidated.
 *
 * The write reaches both levels, and this one condition is the whole gate on
 * persistence: a day that is not stable and closed is no more written to the table
 * than it is to the map.
 */
export function cacheDayDigest(key: DayDigestKey, now: Date, digest: UsageDigest, stable: boolean): UsageDigest {
  if (stable && isClosedDay(key.date, now)) {
    dayDigests.set(keyOf(key), digest);
    storeDayDigest(storedKeyOf(key), digest);
  }
  return digest;
}

/**
 * Read one day's digest through the memo. `compute` runs only on a miss at both
 * levels, and its answer is kept only when the day is closed. A `null` is never
 * stored at either level — a day can gain its archive later, and a sticky miss in
 * a table would pin the gap in place across every later restart.
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
