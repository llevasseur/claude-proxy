import { access } from 'node:fs/promises';
import { isUsageRecord, type LearnedCeilings, learnCeilings } from '@claude-proxy/core';
import { isClosedDay } from './day-digest-memo.js';
import { fileSource, type SidecarSource } from './db/source.js';
import { clearStoredUsageDays, readStoredUsageDay, storeUsageDay } from './db/usage-day-store.js';
import { rawArchiveDayDir, shiftDay, today } from './logs.js';

/**
 * The archive, read for both halves of the usage meters: the ceilings no env var
 * pins down, and the spending those ceilings are measured against.
 *
 * The live log directory holds roughly a day and cannot span a completed weekly
 * window, so the archive is the only place either can come from. Both passes are
 * expensive and slow-moving, hence the caches, and both read a day through the
 * same one, so an overlapping day is parsed once rather than once each.
 *
 * That day cache has two levels, as `/api/summary`'s does. The map below is level
 * one; `db/usage-day-store.ts` is level two, a row per closed archived day, and it
 * is the one that makes a **cold** read cheap — a map only helps the second read,
 * so a restarted server used to re-read all 28 days of the learning span for the
 * first Overview load. A miss at either level reads the day exactly as before.
 */

/** Four weeks — room for three completed weekly windows, without reading the whole archive. */
const LEARN_DAYS = 28;

/** Long enough that the cost is amortised, short enough that a new peak lands the same day. */
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; logDir: string; kind: string; ceilings: LearnedCeilings } | null = null;

/** Drop the memo — for tests, and for anything that rewrites the archive. */
export function clearLearnedCeilingsCache(): void {
  cache = null;
}

// A finalized day never changes, so each is parsed once and held for the process
// lifetime rather than re-read on every SSE tick. An *absent* day is deliberately
// not cached: the archive job may not have run yet, and a sticky miss would pin
// the gap in place until restart.
const dayCache = new Map<string, { sidecars: unknown[]; parseErrors: number }>();

/**
 * Reads already in flight, keyed as {@link dayCache} is.
 *
 * `loadArchivedUsage` and `loadLearnedCeilings` run concurrently and their spans
 * overlap by eight days. Without this the two miss the map together and read each
 * shared day twice.
 */
const inFlight = new Map<string, Promise<ArchivedDayRead>>();

/** Test-only: drop the per-day archived-sidecar cache, both levels. */
export function clearArchivedUsageCache(opts: { keepPersisted?: boolean } = {}): void {
  dayCache.clear();
  inFlight.clear();
  if (!opts.keepPersisted) clearStoredUsageDays();
}

interface ArchivedDayRead {
  sidecars: unknown[];
  parseErrors: number;
  retained: boolean;
}

/**
 * One entry of an archived day, cut down to what the meters read.
 *
 * `learnCeilings` and `buildUsageLimits` between them consult a request's
 * timestamp, model, tokens and rate-limit headers, and `buildUsage` consults its
 * `__file` to dedupe the archive/live seam. Everything else on a sidecar is read
 * off the *live* half or not at all, and it is the bulk of what a day costs to
 * deserialize.
 *
 * An entry that is not a usable request keeps its `__file` and nothing else,
 * rather than being dropped: `/api/usage` reports `meta.files` as the length of
 * this stream, so dropping one would silently understate it.
 */
function projectUsage(sidecar: unknown): Record<string, unknown> {
  const file = (sidecar as { __file?: unknown })?.__file;
  const out: Record<string, unknown> = typeof file === 'string' ? { __file: file } : {};
  if (!isUsageRecord(sidecar)) return out;
  out.timestamp = sidecar.timestamp;
  out.model = sidecar.model;
  out.tokens = sidecar.tokens;
  if (sidecar.rateLimit) out.rateLimit = sidecar.rateLimit;
  return out;
}

/**
 * One archived day, projected once per process, and whether it is retained at all
 * — its own directory being on disk is what makes it so.
 *
 * Retention stays a question for the filesystem even on a level-two hit: a stored
 * row says what the day held, never that the day is still there, and a pruned day
 * has to keep reading as the hole in the window that it is.
 */
async function readArchivedDayMemo(
  logDir: string,
  day: string,
  source: SidecarSource,
  now: Date,
): Promise<ArchivedDayRead> {
  // The backing is part of the key: the parity harness reads the same day both
  // ways, and one shared entry would make the second read trivially agree.
  const key = `${source.kind}\n${logDir}\n${day}`;
  const hit = dayCache.get(key);
  if (hit) return { ...hit, retained: true };
  const pending = inFlight.get(key);
  if (pending) return pending;

  const read = (async (): Promise<ArchivedDayRead> => {
    // Retention is a fact about the filesystem: a day is retained when its own
    // directory is on disk, whichever backing reads it.
    try {
      await access(rawArchiveDayDir(logDir, day));
    } catch {
      return { sidecars: [], parseErrors: 0, retained: false }; // never archived, or pruned
    }

    const closed = isClosedDay(day, now);
    const storedKey = { backing: source.kind, logDir, date: day };
    const stored = closed ? readStoredUsageDay(storedKey) : undefined;
    if (stored) {
      const entry = { sidecars: stored.records, parseErrors: stored.parseErrors };
      dayCache.set(key, entry);
      return { ...entry, retained: true };
    }

    // `omitTools` because nothing below reads the tool table, and on the
    // substrate it is the one query whose size is the day times its tool count.
    const fresh = await source.readArchivedDay(logDir, day, { includeFile: true, omitTools: true });
    const entry = { sidecars: fresh.sidecars.map(projectUsage), parseErrors: fresh.parseErrors };
    dayCache.set(key, entry);
    // Only a day that can no longer change is kept across the restart.
    if (closed) storeUsageDay(storedKey, { records: entry.sidecars, parseErrors: entry.parseErrors });
    return { ...entry, retained: true };
  })();

  inFlight.set(key, read);
  try {
    return await read;
  } finally {
    inFlight.delete(key);
  }
}

/**
 * Every sidecar in the learning span, live plus archived. A day directory that
 * was never written or has been pruned contributes nothing.
 */
async function readLearningCorpus(logDir: string, now: Date, source: SidecarSource): Promise<unknown[]> {
  const { sidecars } = await source.readSidecars(logDir, { sinceDays: LEARN_DAYS }, now);
  const corpus: unknown[] = [...sidecars];
  let day = today(now);
  for (let i = 0; i < LEARN_DAYS; i += 1) {
    day = shiftDay(day, -1);
    const archived = await readArchivedDayMemo(logDir, day, source, now);
    corpus.push(...archived.sidecars);
  }
  return corpus;
}

/**
 * Learned ceilings for `logDir`, recomputed at most once per {@link TTL_MS}.
 * Returns `{}` when history is too thin to complete a single window.
 */
export async function loadLearnedCeilings(
  logDir: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<LearnedCeilings> {
  const at = now.getTime();
  if (cache && cache.logDir === logDir && cache.kind === source.kind && at - cache.at < TTL_MS) return cache.ceilings;
  const ceilings = learnCeilings(await readLearningCorpus(logDir, now, source), now);
  cache = { at, logDir, kind: source.kind, ceilings };
  return ceilings;
}

/** Archived days the meters reach into — the widest window, plus the day the live read overlaps. */
const USAGE_DAYS = 8;

export interface ArchivedUsage {
  sidecars: unknown[];
  /** Archived day labels whose directory is on disk. */
  retainedDays: string[];
  parseErrors: number;
}

/**
 * Archived sidecars for the days the usage windows reach back into, and which of
 * those days are retained at all.
 *
 * A day counts as retained when its own directory exists. Folders are named for
 * the UTC day the job moved, so a reporting day straddling `date` and `date + 1`
 * can read as understated at that seam — the safe direction, marking the window
 * `partial` rather than passing an incomplete count off as a total.
 */
export async function loadArchivedUsage(
  logDir: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ArchivedUsage> {
  const out: ArchivedUsage = { sidecars: [], retainedDays: [], parseErrors: 0 };
  let day = today(now);
  for (let i = 0; i < USAGE_DAYS; i += 1) {
    day = shiftDay(day, -1);
    const archived = await readArchivedDayMemo(logDir, day, source, now);
    if (!archived.retained) continue; // a real hole in the window
    out.retainedDays.push(day);
    out.sidecars.push(...archived.sidecars);
    out.parseErrors += archived.parseErrors;
  }
  return out;
}
