import { learnCeilings, type LearnedCeilings } from "@claude-proxy/core";
import { readArchivedDay, readSidecars, shiftDay, today } from "./logs.js";

/**
 * Ceilings learned from the archive, for the windows no env var pins down.
 *
 * The live log directory holds roughly a day, so on its own it cannot span even
 * one completed weekly window — the archive is the only place a weekly ceiling
 * can come from. That makes this pass expensive (thousands of sidecars across
 * weeks of day directories), and the answer barely moves: it can only change
 * when a window completes. So it is computed rarely and cached.
 */

/**
 * How far back to read. Four weeks leaves room for three completed weekly
 * windows, so the weekly ceiling rests on more than a single observation, while
 * still bounding how much of the archive one pass touches.
 */
const LEARN_DAYS = 28;

/** Long enough that the cost is amortised, short enough that a new peak lands the same day. */
const TTL_MS = 60 * 60 * 1000;

let cache: { at: number; logDir: string; ceilings: LearnedCeilings } | null = null;

/** Drop the memo — for tests, and for anything that rewrites the archive. */
export function clearLearnedCeilingsCache(): void {
  cache = null;
}

/**
 * Every sidecar in the learning span, live plus archived.
 *
 * Day directories that were never archived or have been pruned simply
 * contribute nothing; a gap is indistinguishable from a quiet day here, which
 * only ever costs the learned peak, never inflates it.
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
