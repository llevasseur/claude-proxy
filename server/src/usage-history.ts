import { access } from "node:fs/promises";
import { learnCeilings, type LearnedCeilings } from "@claude-proxy/core";
import { fileSource, type SidecarSource } from "./db/source.js";
import { rawArchiveDayDir, shiftDay, today } from "./logs.js";

/**
 * The archive, read for both halves of the usage meters: the ceilings no env var
 * pins down, and the spending those ceilings are measured against.
 *
 * The live log directory holds roughly a day and cannot span a completed weekly
 * window, so the archive is the only place either can come from. Both passes are
 * expensive and slow-moving, hence the memos, and both read a day through the
 * same one, so an overlapping day is parsed once rather than once each.
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

/** Test-only: drop the per-day archived-sidecar memo. */
export function clearArchivedUsageCache(): void {
  dayCache.clear();
}

/**
 * One archived day, parsed at most once per process, and whether it is retained
 * at all — its own directory being on disk is what makes it so.
 */
async function readArchivedDayMemo(
  logDir: string,
  day: string,
  source: SidecarSource,
): Promise<{ sidecars: unknown[]; parseErrors: number; retained: boolean }> {
  // The backing is part of the key: the parity harness reads the same day both
  // ways, and one shared entry would make the second read trivially agree.
  const key = `${source.kind}\n${logDir}\n${day}`;
  const hit = dayCache.get(key);
  if (hit) return { ...hit, retained: true };
  // Retention is a fact about the filesystem, not about the substrate: a day is
  // retained when its own directory is on disk, whichever backing reads it.
  try {
    await access(rawArchiveDayDir(logDir, day));
  } catch {
    return { sidecars: [], parseErrors: 0, retained: false }; // never archived, or pruned
  }
  const read = await source.readArchivedDay(logDir, day, { includeFile: true });
  const entry = { sidecars: read.sidecars, parseErrors: read.parseErrors };
  dayCache.set(key, entry);
  return { ...entry, retained: true };
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
    const archived = await readArchivedDayMemo(logDir, day, source);
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
    const archived = await readArchivedDayMemo(logDir, day, source);
    if (!archived.retained) continue; // a real hole in the window
    out.retainedDays.push(day);
    out.sidecars.push(...archived.sidecars);
    out.parseErrors += archived.parseErrors;
  }
  return out;
}
