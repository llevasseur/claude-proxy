import { isClosedDay } from './day-digest-memo.js';
import {
  clearStoredContextDays,
  readStoredContextDay,
  type StoredContextDay,
  type StoredContextDayKey,
  storeContextDay,
} from './db/context-day-store.js';
import type { SidecarSource } from './db/source.js';

/**
 * Per-day context aggregates for reporting days that can no longer change, in two
 * levels: this map, held for the process lifetime, over a row per day in
 * `context_day`, which outlives the process.
 *
 * It is `day-digest-memo.ts` in the same shape, for a different question. The
 * second level is what makes a *cold* read cheap: a map only helps the second read
 * and later, so a restarted server used to pay the whole window scan again for the
 * first load of `/api/context`.
 *
 * Today is never stored at either level: an aggregate is only kept for a reporting
 * day strictly earlier than the one `now` falls in, and any day still split across
 * the live directory and the archive is recomputed on every read.
 *
 * The map is unbounded, like the ones it sits beside, and bounded in practice by
 * the number of distinct closed days a process is asked for — one object per day,
 * growing at most a day per day of uptime.
 */

/**
 * What makes two reads of "the same reporting day" the same. The backing is part
 * of it because the parity harness reads both ways and the two must never share
 * an entry.
 */
export interface ContextDayKey {
  logDir: string;
  date: string;
  source: SidecarSource;
}

const contextDays = new Map<string, StoredContextDay>();

/**
 * Test-only, and for anything that rewrites the archive: drop the memo.
 *
 * Both levels by default. `keepPersisted` drops only the in-process map, which is
 * how a test spells "restart the server" — the rows stay, and a fresh process
 * finds them.
 */
export function clearContextDayMemo(opts: { keepPersisted?: boolean } = {}): void {
  contextDays.clear();
  if (!opts.keepPersisted) clearStoredContextDays();
}

function keyOf(key: ContextDayKey): string {
  return `${key.source.kind} ${key.logDir} ${key.date}`;
}

/** The same components as {@link keyOf}, as the persisted row's key. */
function storedKeyOf(key: ContextDayKey): StoredContextDayKey {
  return { backing: key.source.kind, logDir: key.logDir, date: key.date };
}

/**
 * A held aggregate for that day, or `undefined` — the in-process map first, then
 * the row an earlier process left. A hit at either level costs no corpus read,
 * which is why a caller checks this before reading the day at all; a level-two hit
 * is promoted into the map, so the row is read at most once per process per day.
 */
export function cachedContextDay(key: ContextDayKey): StoredContextDay | undefined {
  const memoKey = keyOf(key);
  const held = contextDays.get(memoKey);
  if (held) return held;
  const stored = readStoredContextDay(storedKeyOf(key));
  if (stored) contextDays.set(memoKey, stored);
  return stored;
}

/**
 * Keep `day` for `key`, if the reporting day is one that can no longer change.
 *
 * `stable` is the caller's answer to "is this day still moving?" — a day the live
 * directory still holds part of is passed as unstable. That, plus the
 * {@link isClosedDay} guard, is how a split day is handled: never keyed at all,
 * rather than keyed on something that would have to be invalidated.
 *
 * The write reaches both levels, and this one condition is the whole gate on
 * persistence: an unstable or open day reaches the table no more than the map.
 */
export function cacheContextDay(
  key: ContextDayKey,
  now: Date,
  day: StoredContextDay,
  stable: boolean,
): StoredContextDay {
  if (stable && isClosedDay(key.date, now)) {
    contextDays.set(keyOf(key), day);
    storeContextDay(storedKeyOf(key), day);
  }
  return day;
}
