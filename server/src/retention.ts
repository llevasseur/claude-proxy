/**
 * Retention and lifecycle ownership for `logs/`: archive past days, then evict
 * body files inside expired archived days. **Eviction is per file, and
 * `.audit.json` is never evicted** — the sidecars are the metrics, and every field
 * in them maps to a column in the substrate. See
 * `docs/features/retention-lifecycle.md`.
 *
 * The planner is pure: it takes a listing and returns the moves and deletions it
 * would make. {@link collectRetentionCorpus} reads the listing and
 * {@link applyRetention} performs the plan; neither decides anything.
 */
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { REPORT_TZ } from '@claude-proxy/core';

export const DEFAULT_RETENTION_DAYS = 30;

/** The only files eviction removes; everything else in an archived day is kept forever. */
export const EVICTABLE_SUFFIXES = ['.md', '.request.txt'] as const;

/** The sidecar suffix. Named here so the "never evict this" rule is greppable. */
export const RETAINED_SUFFIX = '.audit.json';

/** The leading `YYYY-MM-DD` of a log filename, which is the day it is filed under. */
const DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})/;

/** An archive directory name — exactly a date, nothing else. */
const DAY_DIR_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface FileEntry {
  name: string;
  bytes: number;
}

/** One `archive/<day>/` directory's listing. */
export interface ArchiveDayEntry {
  day: string;
  files: FileEntry[];
}

/** What the planner is given: the live directory's files and every archived day. */
export interface RetentionCorpus {
  live: FileEntry[];
  archive: ArchiveDayEntry[];
}

/** A file to move out of the live directory into `archive/<day>/`. */
export interface ArchiveMove {
  name: string;
  day: string;
  bytes: number;
}

export interface EvictFile {
  day: string;
  name: string;
  bytes: number;
}

export interface RetentionPlan {
  /** The reporting-zone day the plan was computed for. Files on/after it stay put. */
  today: string;
  retentionDays: number;
  /** Archived days strictly older than this have their bodies evicted. */
  cutoff: string;
  archive: {
    moves: ArchiveMove[];
    /** Destination days touched, ascending. */
    days: string[];
    /** Bytes relocated. Reclaims nothing — a rename frees no space. */
    bytes: number;
  };
  evict: {
    files: EvictFile[];
    days: string[];
    /** Bytes reclaimed. */
    bytes: number;
  };
}

/** `YYYY-MM-DD` shifted by whole days, via UTC so no zone can shorten a day. */
export function shiftDate(date: string, deltaDays: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

/** Today in the reporting zone; `TIMEZONE` overrides it. */
export function resolveToday(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const tz = env.TIMEZONE || REPORT_TZ;
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    now,
  );
}

/** `RETENTION_DAYS`, or 30. A non-numeric or negative value falls back to the default. */
export function resolveRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RETENTION_DAYS;
  if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_RETENTION_DAYS;
}

/** The day a log file is filed under, or `null` for a name that carries no date. */
export function logFileDay(name: string): string | null {
  return name.match(DATE_PREFIX_RE)?.[1] ?? null;
}

/** True for the body files eviction removes. `.audit.json` can never match. */
export function isEvictable(name: string): boolean {
  return EVICTABLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Decide what to archive and what to evict. Pure — same input, same plan, no disk.
 *
 * A file is moved only when its name carries a date **strictly before** `today`.
 * A name with no date prefix is never a candidate, which is what keeps
 * `sessions/`, `commands/`, `.chat/`, `suggestion-status.json` and the database
 * out of it. Filenames carry the proxy's UTC prefix and UTC runs ahead of the
 * reporting zone, so "strictly before" also protects tomorrow-stamped files that
 * belong to today's reporting day.
 *
 * Eviction runs over the archive as it will be *after* the moves, so a body
 * landing in an already-expired day does not survive until the next run. Only the
 * day directory's name decides expiry, and the directory is never removed.
 */
export function planRetention(input: { corpus: RetentionCorpus; today: string; retentionDays: number }): RetentionPlan {
  const { corpus, today, retentionDays } = input;
  const cutoff = shiftDate(today, -retentionDays);

  const moves: ArchiveMove[] = [];
  for (const file of corpus.live) {
    const day = logFileDay(file.name);
    if (!day || day >= today) continue;
    moves.push({ name: file.name, day, bytes: file.bytes });
  }
  moves.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  // The archive as the eviction pass will find it: on disk, plus this run's moves.
  const byDay = new Map<string, FileEntry[]>();
  for (const entry of corpus.archive) {
    if (!DAY_DIR_RE.test(entry.day)) continue;
    byDay.set(entry.day, [...entry.files]);
  }
  for (const move of moves) {
    const files = byDay.get(move.day);
    if (files) files.push({ name: move.name, bytes: move.bytes });
    else byDay.set(move.day, [{ name: move.name, bytes: move.bytes }]);
  }

  const evicted: EvictFile[] = [];
  for (const day of [...byDay.keys()].sort()) {
    if (day >= cutoff) continue;
    for (const file of byDay.get(day) ?? []) {
      if (!isEvictable(file.name)) continue;
      evicted.push({ day, name: file.name, bytes: file.bytes });
    }
  }
  evicted.sort((a, b) => (a.day === b.day ? (a.name < b.name ? -1 : 1) : a.day < b.day ? -1 : 1));

  return {
    today,
    retentionDays,
    cutoff,
    archive: {
      moves,
      days: [...new Set(moves.map((m) => m.day))].sort(),
      bytes: moves.reduce((n, m) => n + m.bytes, 0),
    },
    evict: {
      files: evicted,
      days: [...new Set(evicted.map((e) => e.day))].sort(),
      bytes: evicted.reduce((n, e) => n + e.bytes, 0),
    },
  };
}

/** List one directory's plain files with their sizes; `[]` when it does not exist. */
async function listFiles(dir: string): Promise<FileEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: FileEntry[] = [];
  for (const name of names) {
    try {
      const s = await stat(path.join(dir, name));
      // Directories are skipped, not moved — `archive/` itself is one.
      if (s.isFile()) out.push({ name, bytes: s.size });
    } catch {
      // Vanished between listing and stat — the proxy is writing concurrently.
    }
  }
  return out;
}

/** Read the live directory and every archived day. */
export async function collectRetentionCorpus(logDir: string): Promise<RetentionCorpus> {
  const live = await listFiles(logDir);
  const archiveRoot = path.join(logDir, 'archive');
  let days: string[];
  try {
    days = (await readdir(archiveRoot)).filter((d) => DAY_DIR_RE.test(d)).sort();
  } catch {
    days = [];
  }
  const archive: ArchiveDayEntry[] = [];
  for (const day of days) {
    archive.push({ day, files: await listFiles(path.join(archiveRoot, day)) });
  }
  return { live, archive };
}

export interface RetentionResult {
  archived: number;
  evicted: number;
  /** Bytes reclaimed by the deletions that succeeded. */
  bytesReclaimed: number;
  /** Per-file failures, as `<what>: <message>`. Never fatal — the next run retries. */
  errors: string[];
}

/**
 * Perform a plan. Archiving runs first and in full, so eviction only ever deletes
 * from inside `archive/<day>/`. A file that fails to move has its eviction
 * skipped — the plan's path for it no longer describes the disk.
 */
export async function applyRetention(logDir: string, plan: RetentionPlan): Promise<RetentionResult> {
  const result: RetentionResult = { archived: 0, evicted: 0, bytesReclaimed: 0, errors: [] };
  const failedMoves = new Set<string>();

  for (const move of plan.archive.moves) {
    const dest = path.join(logDir, 'archive', move.day);
    try {
      await mkdir(dest, { recursive: true });
      await rename(path.join(logDir, move.name), path.join(dest, move.name));
      result.archived += 1;
    } catch (err) {
      failedMoves.add(`${move.day}/${move.name}`);
      result.errors.push(`archive ${move.name}: ${(err as Error).message}`);
    }
  }

  for (const file of plan.evict.files) {
    const key = `${file.day}/${file.name}`;
    if (failedMoves.has(key)) continue;
    try {
      await unlink(path.join(logDir, 'archive', file.day, file.name));
      result.evicted += 1;
      result.bytesReclaimed += file.bytes;
    } catch (err) {
      result.errors.push(`evict ${key}: ${(err as Error).message}`);
    }
  }

  return result;
}
