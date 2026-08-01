import { access } from "node:fs/promises";
import { learnCeilings, type LearnedCeilings } from "@claude-proxy/core";
import { rawArchiveDayDir, readArchivedDay, readSidecars, shiftDay, today } from "./logs.js";

/**
 * The archive, read for both halves of the usage meters: the ceilings no env var
 * pins down, and the spending those ceilings are measured against.
 *
 * The live log directory holds roughly a day and cannot span a completed weekly
 * window, so the archive is the only place either can come from. Both passes are
 * expensive and slow-moving, hence the memos.
 */

/** Four weeks — room for three completed weekly windows, without reading the whole archive. */
const LEARN_DAYS = 28;

/** Long enough that the cost is amortised, short enough that a new peak lands the same day. */
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; logDir: string; ceilings: LearnedCeilings } | null = null;

/** Drop the memo — for tests, and for anything that rewrites the archive. */
export function clearLearnedCeilingsCache(): void {
  cache = null;
}

/**
 * Every sidecar in the learning span, live plus archived. A day directory that
 * was never written or has been pruned contributes nothing.
 */
async function readLearningCorpus(logDir: string, now: Date): Promise<unknown[]> {
  const { sidecars } = await readSidecars(logDir, { sinceDays: LEARN_DAYS }, now);
  const corpus: unknown[] = [...sidecars];
  let day = today(now);
  for (let i = 0; i < LEARN_DAYS; i += 1) {
    day = shiftDay(day, -1);
    const archived = await readArchivedDay(logDir, day);
    corpus.push(...archived.sidecars);
  }
  return corpus;
}

/**
 * Learned ceilings for `logDir`, recomputed at most once per {@link TTL_MS}.
 * Returns `{}` when history is too thin to complete a single window.
 */
export async function loadLearnedCeilings(logDir: string, now: Date = new Date()): Promise<LearnedCeilings> {
  const at = now.getTime();
  if (cache && cache.logDir === logDir && at - cache.at < TTL_MS) return cache.ceilings;
  const ceilings = learnCeilings(await readLearningCorpus(logDir, now), now);
  cache = { at, logDir, ceilings };
  return ceilings;
}

/** Archived days the meters reach into — the widest window, plus the day the live read overlaps. */
const USAGE_DAYS = 8;

// A finalized day never changes, and re-reading thousands of sidecar files on
// every SSE tick is not affordable, so each day is parsed once and held for the
// process lifetime. An *absent* day is deliberately not cached: the archive job
// may simply not have run yet, and caching the miss would pin the gap in place
// until a restart.
const dayCache = new Map<string, { sidecars: unknown[]; parseErrors: number }>();

/** Test-only: drop the per-day archived-sidecar memo. */
export function clearArchivedUsageCache(): void {
  dayCache.clear();
}

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
 * A day counts as retained when its own directory exists. A reporting day can
 * straddle `date` and `date + 1` — folders are named for the UTC day the job moved
 * — so requiring the day's own folder can understate coverage at that seam. That
 * is the safe direction: it marks the window `partial` rather than presenting an
 * incomplete count as a total.
 */
export async function loadArchivedUsage(logDir: string, now: Date = new Date()): Promise<ArchivedUsage> {
  const out: ArchivedUsage = { sidecars: [], retainedDays: [], parseErrors: 0 };
  let day = today(now);
  for (let i = 0; i < USAGE_DAYS; i += 1) {
    day = shiftDay(day, -1);
    try {
      await access(rawArchiveDayDir(logDir, day));
    } catch {
      continue; // never archived, or pruned — a real hole in the window
    }
    out.retainedDays.push(day);

    const key = `${logDir}\n${day}`;
    let hit = dayCache.get(key);
    if (!hit) {
      const r = await readArchivedDay(logDir, day, { includeFile: true });
      hit = { sidecars: r.sidecars, parseErrors: r.parseErrors };
      dayCache.set(key, hit);
    }
    out.sidecars.push(...hit.sidecars);
    out.parseErrors += hit.parseErrors;
  }
  return out;
}
