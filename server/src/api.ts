import {
  type Advice,
  type AdviceMovement,
  type AliasLoadExpectation,
  type AuditSidecar,
  adviceMovement,
  analyzeRequestBody,
  assertJudgeableCorpus,
  attributePromptMix,
  type BucketBreakdownInput,
  type BucketBreakdownSummary,
  type BucketJudgementRow,
  type BucketJudgementState,
  bucketJudgementState,
  bucketJudgements,
  buildUsageLimits,
  type CommandPattern,
  type CommandRun,
  type CommandRunShape,
  type CommandStep,
  type CommandSummary,
  type ContextEntry,
  type ContextSummary,
  commandRunShapes,
  computeAliasPosture,
  computeDigest,
  computeSkimDigest,
  countBucketJudgementStates,
  countIdeaStatuses,
  countSuggestionRecurrences,
  countSuggestionStatuses,
  dayElapsedFraction,
  dayOf,
  deriveRequestErrors,
  deriveSessionNodes,
  diffWirePrompts,
  extractRequestMessage,
  extractRequestTool,
  type FiltersResponse,
  filterRunsByFlags,
  flattenHooks,
  type HookRow,
  heuristicAdvice,
  hookPluginLoadExpectations,
  type IdeaEntry,
  type IdeaFilter,
  type IdeaMark,
  type IdeaStatus,
  ideaRows,
  isAuditSidecar,
  isPartialDay,
  type JobTreeNode,
  jobStateTone,
  type LaunchAlias,
  type LaunchAliasPosture,
  type LinkedSessionError,
  linkRequestErrors,
  type MixAttribution,
  normalizePlugins,
  type PatternFrequency,
  type PluginRow,
  PROXY_FILTER_INVENTORY,
  type PromptMixDay,
  type PromptRevision,
  pairPromptRevisions,
  parseSessionErrors,
  parseSystemPromptText,
  patternFrequency,
  type RequestBreakdown,
  type RequestErrorSite,
  type RequestMessageDetail,
  type RequestToolDetail,
  type RuleDefect,
  reportDay,
  ruleDefects,
  runKey,
  runTotals,
  SESSION_BUCKET_SIZE,
  type SectionMove,
  type SectionShare,
  type SessionBucket,
  type SessionContextPeak,
  type SessionError,
  type SessionErrorLink,
  type SessionMeta,
  type SessionNode,
  type SessionSuggestion,
  type SkimDigest,
  type SkimShape,
  type StepReach,
  type StoredConcept,
  type StoredWirePrompt,
  SUGGESTION_DEFECT_THRESHOLDS,
  type SuggestionJudgementWrite,
  type SuggestionRecurrence,
  type SuggestionStatus,
  type SuggestionStatusRow,
  type SuggestionStatusUpdate,
  SYSTEM_PROMPT_MAX_BYTES,
  type SystemPromptDoc,
  sectionShares,
  sessionContextPeak,
  sessionSuggestionBuckets,
  skimDigestsByDay,
  stepReach,
  suggestFromBreakdown,
  suggestionStatusRows,
  summarizeBreakdownPatterns,
  summarizeCommands,
  summarizeContext,
  summarizePromptMix,
  summarizeSystemPrompt,
  type TopTool,
  toContextEntry,
  type UsageDigest,
  type UsageLimitConfig,
  type UsageLimitsSnapshot,
  type WithheldReport,
  wirePromptSectionTexts,
  withheldReport,
  withoutMetaSkills,
} from '@claude-proxy/core';
import { loadArchivedDigest } from './archive.js';
import { listInstalledCommands } from './command-runs.js';
import { conceptStorePath } from './concepts.js';
import { fileSource, type SidecarSource } from './db/source.js';
import { markIdeasInStore, readIdeasStore, resolveIdeasPath } from './ideas-store.js';
import {
  deleteJob,
  type JobDeleteResult,
  type JobFileDetail,
  type JobSummary,
  listJobs,
  readJob,
  readJobFile,
} from './jobs.js';
import {
  type LoadResult,
  locateRequestBody,
  type ReadOptions,
  type RequestBodyLocation,
  readRequestBody,
  readRetainedSidecar,
  shiftDay,
  today,
} from './logs.js';
import {
  listProjectMemories,
  listProjects,
  type MemoryDetail,
  type MemoryFileSummary,
  type ProjectSummary,
  readMemory,
} from './projects.js';
import { classifierPromptHashes, readStoredPrompt, readStoredPrompts } from './prompt-store.js';
import { resolveRetentionDays } from './retention.js';
import {
  type SessionDetail,
  type SessionGraph,
  type SessionNodeTexts,
  type SessionSummary,
  threadIdForBody,
} from './sessions.js';
import { readDeviceSettings, resolveSettingsPath } from './settings.js';
import { readLaunchAliases } from './shell-rc.js';
import {
  judgeSuggestionStatusStore,
  readSuggestionStatusStore,
  resolveSuggestionStatusPath,
  updateSuggestionStatusStore,
} from './suggestion-status.js';
import { readSystemPromptFile, resolveSystemPromptPath, writeSystemPromptFile } from './system-prompt.js';
import { loadArchivedUsage, loadLearnedCeilings } from './usage-history.js';
import { loadLiveUsage } from './usage-live.js';

export interface SummaryResponse {
  digest: UsageDigest;
  advice: Advice[];
  /**
   * One entry per piece of advice, saying whether the metric it fired on has
   * moved since the last day that recorded anything. The dashboard collapses the
   * steady ones rather than dropping them — see `adviceMovement`.
   */
  movement: AdviceMovement[];
  meta: { date: string; files: number; parseErrors: number };
}

/**
 * One reporting day's sidecars, archived half first so the stream stays
 * chronological.
 *
 * `readSidecars` only ever scans the live directory. A reporting day is a
 * `REPORT_TZ` day while the summary job rotates on the *UTC* day, so a day near
 * the present sits in both places and an older one is archived outright —
 * reading only the live side reports a fraction of the day, then nothing.
 *
 * `archiveDir` extends the archived half to a day whose raw triples were
 * relocated off the log volume; without it such a day reads as empty.
 */
async function daySidecars(
  logDir: string,
  date: string,
  now: Date,
  source: SidecarSource,
  archiveDir?: string,
  opts: Omit<ReadOptions, 'date' | 'sinceDays'> = {},
): Promise<LoadResult> {
  const [archived, live] = await Promise.all([
    source.readArchivedDay(logDir, date, { ...opts, archiveDir }),
    source.readSidecars(logDir, { ...opts, date }, now),
  ]);
  return {
    sidecars: [...archived.sidecars, ...live.sidecars],
    files: archived.files + live.files,
    parseErrors: archived.parseErrors + live.parseErrors,
    bodiesEvicted: (archived.bodiesEvicted ?? 0) + (live.bodiesEvicted ?? 0),
  };
}

/**
 * How far back the summary will look for a day to compare against. Reached only
 * when every day in between was idle; a longer gap leaves the trend unreported.
 */
const SUMMARY_BASELINE_LOOKBACK_DAYS = 14;

/**
 * The days before `day` that the trend is measured against, oldest→newest. The
 * walk stops at the first day that captured anything; the idle days it passed are
 * returned too, since whether one is empty is decided per field.
 *
 * A walked day with no raw sidecars falls back to its finalized digest, the same
 * order {@link buildTrends} resolves an archived day in. Raw triples are pruned
 * on a retention clock while a finalized digest is kept indefinitely.
 */
async function baselineDigests(
  logDir: string,
  day: string,
  now: Date,
  source: SidecarSource,
  classifierHashes: ReadonlySet<string>,
  archiveDir?: string,
): Promise<UsageDigest[]> {
  const digests: UsageDigest[] = [];
  for (let back = 1; back <= SUMMARY_BASELINE_LOOKBACK_DAYS; back += 1) {
    const date = shiftDay(day, -back);
    const read = await daySidecars(logDir, date, now, source, archiveDir);
    const digest =
      read.files === 0 && archiveDir
        ? ((await loadArchivedDigest(archiveDir, date)) ?? computeDigest([], { date, classifierHashes }))
        : computeDigest(read.sidecars, { date, classifierHashes });
    digests.unshift(digest);
    if (digest.requestCount > 0) break;
  }
  return digests;
}

/**
 * One day's digest + advice, with each field's trend computed against the last
 * earlier day that recorded it. Every day read spans the archive and the live
 * dir — see {@link daySidecars}.
 *
 * `source` selects where the sidecars come from: the directory scan by default,
 * the SQLite substrate when the parity harness or shadow mode asks for it. See
 * `server/src/db/source.ts`.
 */
export async function buildSummary(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  archiveDir?: string,
  source: SidecarSource = fileSource,
): Promise<SummaryResponse> {
  const day = date ?? today(now);
  const [cur, classifierHashes] = await Promise.all([
    daySidecars(logDir, day, now, source, archiveDir),
    classifierPromptHashes(logDir),
  ]);
  const priorDigests = await baselineDigests(logDir, day, now, source, classifierHashes, archiveDir);
  const digest = computeDigest(cur.sidecars, { date: day, priorDigests, classifierHashes });
  const advice = await heuristicAdvice.advise(digest);
  // `baselineDigests` walks backwards and unshifts, so the busy day it stopped on is
  // first; the idle days it passed carry no metric worth comparing against.
  const prior = priorDigests.find((d) => d.requestCount > 0) ?? null;
  return {
    digest,
    advice,
    movement: adviceMovement(advice, digest, prior),
    meta: { date: day, files: cur.files, parseErrors: cur.parseErrors },
  };
}

export interface UsageResponse {
  usage: UsageLimitsSnapshot;
  meta: { files: number; parseErrors: number };
}

/**
 * One sidecar per source file, first occurrence winning.
 *
 * Archiving is expected to *move* files, so live and archived reads should not
 * overlap — but a copy-based archiver would double every request in the seam.
 * Entries without a `__file` are passed through rather than collapsed together.
 */
function dedupeByFile(sidecars: readonly unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const s of sidecars) {
    const file = (s as { __file?: unknown })?.__file;
    if (typeof file !== 'string') {
      out.push(s);
      continue;
    }
    if (seen.has(file)) continue;
    seen.add(file);
    out.push(s);
  }
  return out;
}

/**
 * The live usage meters, over the trailing week — the widest window any meter
 * spans. `sinceDays: 8` rather than 7 because the filter is day-granular while the
 * windows are instant-granular; the extra day covers the partial day.
 *
 * The live directory holds roughly a day, so on its own it leaves a weekly window
 * counting a few hours and calling it a week. Archived days are read alongside it,
 * and the retained days passed through so `coverage` can see a hole in the window.
 * Ceilings come from a wider slice again, precomputed and cached — see
 * `usage-history.ts`.
 */
export async function buildUsage(
  logDir: string,
  limits: UsageLimitConfig,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<UsageResponse> {
  const live = await source.readSidecars(logDir, { sinceDays: 8, includeFile: true }, now);
  const archived = await loadArchivedUsage(logDir, now, source);
  const learned = await loadLearnedCeilings(logDir, now, source);

  const liveUsage = await loadLiveUsage(logDir, now);

  const sidecars = dedupeByFile([...live.sidecars, ...archived.sidecars]);
  // The live directory is the current day's destination, so that day is retained
  // whether or not anything landed in it; days a live sidecar names are retained
  // too, for a deployment that rotates less eagerly than the default.
  const retainedDays = new Set<string>([today(now), ...archived.retainedDays]);
  for (const s of live.sidecars) {
    const ts = (s as { timestamp?: unknown })?.timestamp;
    const day = typeof ts === 'string' ? reportDay(ts) : null;
    if (day) retainedDays.add(day);
  }

  return {
    usage: buildUsageLimits(sidecars, {
      limits,
      learned,
      retainedDays: [...retainedDays],
      live: liveUsage.live,
      anchors: liveUsage.anchors,
      now,
    }),
    meta: { files: sidecars.length, parseErrors: live.parseErrors + archived.parseErrors },
  };
}

export interface TrendsResponse {
  digests: UsageDigest[];
  meta: { days: number; files: number; parseErrors: number; archivedDays: number };
}

// Archived days are immutable, so their digests are cached for the process
// lifetime. Misses aren't cached — a day can still gain its archive later.
const rawArchiveDigests = new Map<string, UsageDigest>();

/** Test-only: drop the in-process raw-archive digest cache. */
export function clearRawArchiveCache(): void {
  rawArchiveDigests.clear();
}

/**
 * One archived day's digest, computed from the raw sidecars the summary job
 * moved into `<logDir>/archive/<date>/`. `null` when that day isn't archived.
 */
async function rawArchivedDigest(
  logDir: string,
  date: string,
  source: SidecarSource,
  classifierHashes: ReadonlySet<string>,
  archiveDir?: string,
): Promise<UsageDigest | null> {
  // Keyed by backing as well as day: the parity harness computes both, and a
  // shared entry would hand the second run the first one's answer. The hash-set
  // size joins the key because the store only grows — a digest computed before a
  // new classifier revision was recorded would otherwise never be recomputed.
  // `archiveDir` joins it too, since it decides which roots the day was read from.
  const key = `${source.kind} ${logDir} ${archiveDir ?? ''} ${date} ${classifierHashes.size}`;
  const hit = rawArchiveDigests.get(key);
  if (hit) return hit;

  const { sidecars, files } = await source.readArchivedDay(logDir, date, { archiveDir });
  if (files === 0) return null;

  const digest = computeDigest(sidecars, { date, classifierHashes });
  rawArchiveDigests.set(key, digest);
  return digest;
}

/** Live sidecars bucketed by the reporting day they fall in, malformed ones dropped. */
function liveSidecarsByDay(sidecars: readonly unknown[]): Map<string, unknown[]> {
  const byDate = new Map<string, unknown[]>();
  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    const day = dayOf(s);
    const bucket = byDate.get(day) ?? [];
    bucket.push(s);
    byDate.set(day, bucket);
  }
  return byDate;
}

/**
 * Per-day digests for the last `days` days, oldest→newest.
 *
 * A reporting day is a `REPORT_TZ` day, but the summary job rotates `logs/`
 * into `archive/<date>/` on the *UTC* day. The boundaries do not line up, so a
 * day near the present is split — earlier hours archived, later ones still
 * live — and is read from both halves and digested as one.
 *
 * A day with no live requests at all is fully archived, so its digest is read
 * (and cached) whole, falling back to the archive of finalized digests.
 */
export async function buildTrends(
  logDir: string,
  days: number,
  now: Date = new Date(),
  archiveDir?: string,
  source: SidecarSource = fileSource,
): Promise<TrendsResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { sinceDays: days }, now);
  const classifierHashes = await classifierPromptHashes(logDir);
  const liveByDate = liveSidecarsByDay(sidecars);

  const end = today(now);
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) dates.push(shiftDay(end, -i));

  // Resolved first, digested second: `trend` chains each day against the one before it.
  const raw = new Map<string, unknown[]>();
  const finalized = new Map<string, UsageDigest>();
  let archivedDays = 0;
  for (const date of dates) {
    const live = liveByDate.get(date);
    if (!live?.length) {
      const digest =
        (await rawArchivedDigest(logDir, date, source, classifierHashes, archiveDir)) ??
        (archiveDir ? await loadArchivedDigest(archiveDir, date) : null);
      if (digest) {
        finalized.set(date, digest);
        archivedDays += 1;
      }
      continue;
    }
    // The archived slice precedes the live one, so this order stays chronological.
    const archived = await source.readArchivedDay(logDir, date, { archiveDir });
    if (archived.files > 0) archivedDays += 1;
    raw.set(date, [...archived.sidecars, ...live]);
  }

  const digests: UsageDigest[] = [];
  for (const date of dates) {
    const bucket = raw.get(date);
    const digest: UsageDigest | undefined = bucket
      ? computeDigest(bucket, { date, priorDigests: digests, classifierHashes })
      : finalized.get(date);
    if (!digest) continue;
    digests.push(digest);
  }
  return { digests, meta: { days, files, parseErrors, archivedDays } };
}

/** A prompt revision with both outlines resolved and diffed. */
export interface PromptRevisionDetail extends PromptRevision {
  /** null when the store has no record for that hash — a prompt the proxy never saw. */
  prior: StoredWirePrompt | null;
  current: StoredWirePrompt | null;
  /** Biggest absolute move first; empty when either outline is missing. */
  moves: SectionMove[];
}

export interface PromptMixResponse {
  /** Oldest first, one per day with captured traffic. */
  days: PromptMixDay[];
  /** The two most recent days, decomposed. null when only one day has traffic. */
  attribution: MixAttribution | null;
  /** Section-level detail for prompts that changed across that pair. */
  revisions: PromptRevisionDetail[];
  /** Set when the newest day is still in progress, so its mean is a part-day figure. */
  partial: { date: string; elapsed: number } | null;
  meta: { days: number; files: number; parseErrors: number; archivedDays: number; outlinesFound: number };
}

/** One day of prompt cohorts, oldest first, plus what it cost to read them. */
interface PromptMixWindow {
  mix: PromptMixDay[];
  files: number;
  parseErrors: number;
  archivedDays: number;
}

/**
 * The window both prompt routes decompose. The live dir holds a day or two; the
 * rest of the window is archived sidecars, summarized the same way.
 *
 * Day boundaries split across the two the same way {@link buildTrends} describes,
 * so a day holding live requests is still summarized over both halves.
 */
async function promptMixWindow(
  logDir: string,
  days: number,
  now: Date,
  source: SidecarSource,
): Promise<PromptMixWindow> {
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { sinceDays: days }, now);
  const liveByDate = liveSidecarsByDay(sidecars);
  const byDate = new Map<string, PromptMixDay>();

  let archivedDays = 0;
  const end = today(now);
  for (let i = 0; i < days; i += 1) {
    const date = shiftDay(end, -i);
    const live = liveByDate.get(date) ?? [];
    const archived = await source.readArchivedDay(logDir, date);
    if (archived.files === 0 && !live.length) continue;
    if (archived.files > 0) archivedDays += 1;
    byDate.set(date, summarizePromptMix([...archived.sidecars, ...live], date));
  }

  return { mix: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)), files, parseErrors, archivedDays };
}

/**
 * Why `avgSystemPromptBytes` sits where it does: the day's cohorts, the move
 * since the day before split into traffic mix and prompt size, and the sections
 * that changed when a prompt was rewritten.
 */
export async function buildPromptMix(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<PromptMixResponse> {
  const { mix, files, parseErrors, archivedDays } = await promptMixWindow(logDir, days, now, source);
  const current = mix.at(-1);
  const prior = mix.at(-2);
  const attribution = current && prior ? attributePromptMix(prior, current) : null;

  const revisions: PromptRevisionDetail[] = [];
  let outlinesFound = 0;
  if (current && prior) {
    const paired = pairPromptRevisions(prior, current);
    const outlines = await readStoredPrompts(
      logDir,
      paired.flatMap((r) => [r.priorHash, r.hash]),
    );
    outlinesFound = outlines.size;
    for (const revision of paired) {
      const before = outlines.get(revision.priorHash) ?? null;
      const after = outlines.get(revision.hash) ?? null;
      revisions.push({
        ...revision,
        prior: before,
        current: after,
        moves: before && after ? diffWirePrompts(before, after) : [],
      });
    }
  }

  return {
    days: mix,
    attribution,
    revisions,
    partial:
      current && isPartialDay(current.date, now)
        ? { date: current.date, elapsed: dayElapsedFraction(current.date, now) }
        : null,
    meta: { days, files, parseErrors, archivedDays, outlinesFound },
  };
}

/** One day this prompt ran, and what it did to that day's mean. */
export interface PromptDayUsage {
  date: string;
  requests: number;
  /** Fraction of that day's requests, 0–1. */
  share: number;
  meanBytes: number;
  /** `share × meanBytes` — this prompt's bytes of the day's mean. */
  contribution: number;
  /** The whole day's mean, so the contribution reads as a fraction of it. */
  dayMeanBytes: number;
}

export interface PromptDetailResponse {
  hash: string;
  /** The cohort's own label; the short hash alone when no request sent it. */
  label: string;
  /** Models that sent it, most requests first. */
  models: string[];
  /** null when the store has no outline — the prompt ran before capture existed. */
  outline: StoredWirePrompt | null;
  /** Largest share first; empty without an outline. */
  sections: SectionShare[];
  /** Oldest first, one entry per day of the window that sent this prompt. */
  usage: PromptDayUsage[];
  meta: { days: number; files: number; parseErrors: number; archivedDays: number };
}

/**
 * One prompt from the cohort table, opened up: the sections it is made of and
 * the days it ran.
 *
 * A legacy cohort is keyed by model and size band rather than by a prompt, so
 * it has no outline; it comes back with an empty `usage` and a null `outline`
 * rather than an error, as does an unseen hash.
 */
export async function buildPromptDetail(
  logDir: string,
  hash: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<PromptDetailResponse> {
  const { mix, files, parseErrors, archivedDays } = await promptMixWindow(logDir, days, now, source);

  const usage: PromptDayUsage[] = [];
  const models = new Map<string, number>();
  let label = hash.slice(0, 8);
  for (const day of mix) {
    const cohort = day.cohorts.find((c) => c.key === hash);
    if (!cohort) continue;
    label = cohort.label;
    for (const model of cohort.models) models.set(model, (models.get(model) ?? 0) + cohort.requests);
    usage.push({
      date: day.date,
      requests: cohort.requests,
      share: cohort.share,
      meanBytes: cohort.meanBytes,
      contribution: cohort.contribution,
      dayMeanBytes: day.meanBytes,
    });
  }

  const outline = await readStoredPrompt(logDir, hash);
  return {
    hash,
    label,
    models: [...models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m),
    outline,
    sections: outline ? sectionShares(outline) : [],
    usage,
    meta: { days, files, parseErrors, archivedDays },
  };
}

/** One block's worth of a heading's text, since a heading can repeat across blocks. */
export interface PromptSectionPart {
  block: number;
  bytes: number;
  text: string;
}

export interface PromptSectionResponse {
  hash: string;
  /** The heading as the "what it is made of" table names it. */
  heading: string;
  level: number;
  /** Bytes and share summed across blocks, matching that table's row. */
  bytes: number;
  share: number;
  /** Blocks the heading appears in, ascending. */
  blocks: number[];
  /** Text per block, block order. Empty when no captured body still carries it. */
  parts: PromptSectionPart[];
  /** The request the text was read back from; null when none survives. */
  file: string | null;
  meta: { days: number; files: number; parseErrors: number; candidates: number };
}

/** Bodies to open before giving up on recovering a prompt's text. */
const SECTION_BODY_TRIES = 8;

/**
 * The `__file` handles of requests that sent this prompt, newest first. Reads
 * the live directory and the window's archived days, since the live one holds
 * roughly today and a prompt's cohort spans the window.
 */
async function filesForPromptHash(
  logDir: string,
  hash: string,
  days: number,
  now: Date,
  source: SidecarSource,
): Promise<{ files: string[]; read: number; parseErrors: number }> {
  const found = new Set<string>();
  let read = 0;
  let parseErrors = 0;

  const collect = (sidecars: readonly unknown[]) => {
    for (const s of sidecars) {
      const record = s as { __file?: string; request?: { system?: { hash?: unknown } } };
      if (record.__file && record.request?.system?.hash === hash) found.add(record.__file);
    }
  };

  const live = await source.readSidecars(logDir, { sinceDays: days, includeFile: true }, now);
  read += live.files;
  parseErrors += live.parseErrors;
  collect(live.sidecars);

  const end = today(now);
  for (let i = 0; i < days; i += 1) {
    const archived = await source.readArchivedDay(logDir, shiftDay(end, -i), { includeFile: true });
    read += archived.files;
    parseErrors += archived.parseErrors;
    collect(archived.sidecars);
  }

  // Names lead with their timestamp, so this is newest-first — the likeliest to
  // still have a body behind it.
  return { files: [...found].sort().reverse(), read, parseErrors };
}

/**
 * One row of "what it is made of", opened up to the text behind it.
 *
 * The stored outline keeps byte counts only, so the text has to come back from a
 * request body that sent this prompt — any of them, since the hash is over the
 * prompt itself. Bodies age out well before outlines do, so `parts` comes back
 * empty rather than erroring once every candidate has been evicted.
 *
 * `index` addresses the ranked section table, not the raw outline. Throws a
 * labelled error the server maps to 404 for an unknown hash or index.
 */
export async function buildPromptSection(
  logDir: string,
  hash: string,
  index: number,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<PromptSectionResponse> {
  const outline = await readStoredPrompt(logDir, hash);
  if (!outline) throw new Error(`prompt outline not found: ${hash}`);

  const row = sectionShares(outline)[index];
  if (!row) throw new Error(`prompt section index out of range: ${index}`);

  const { files: candidates, read, parseErrors } = await filesForPromptHash(logDir, hash, days, now, source);

  // Spans of the outline carrying this heading, in outline order — the same
  // order `wirePromptSectionTexts` answers in.
  const spans = outline.sections.flatMap((s, i) =>
    s.heading === row.heading ? [{ at: i, block: s.block, bytes: s.bytes }] : [],
  );

  let parts: PromptSectionPart[] = [];
  let file: string | null = null;
  for (const candidate of candidates.slice(0, SECTION_BODY_TRIES)) {
    let texts: string[];
    try {
      const { body } = await readRequestBody(logDir, candidate);
      texts = wirePromptSectionTexts((body as { system?: unknown }).system);
    } catch {
      continue; // evicted, unreadable, or not the shape we expect
    }
    // A body whose outline no longer lines up is not the prompt this hash names.
    if (texts.length !== outline.sections.length) continue;
    parts = spans.map((s) => ({ block: s.block, bytes: s.bytes, text: texts[s.at]! }));
    file = candidate;
    break;
  }

  return {
    hash,
    heading: row.heading,
    level: row.level,
    bytes: row.bytes,
    share: row.share,
    blocks: row.blocks,
    parts,
    file,
    meta: { days, files: read, parseErrors, candidates: candidates.length },
  };
}

export interface ToolsResponse {
  date: string;
  topTools: TopTool[];
  meta: { files: number; parseErrors: number };
}

/** The full ranked tool-bloat table for a day. */
export async function buildTools(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  archiveDir?: string,
  source: SidecarSource = fileSource,
): Promise<ToolsResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors } = await daySidecars(logDir, day, now, source, archiveDir);
  const digest = computeDigest(sidecars, { date: day, topN: 200 });
  return { date: day, topTools: digest.topTools, meta: { files, parseErrors } };
}

export interface ToolSchemaResponse {
  name: string;
  /**
   * The tool definition as it went over the wire, pretty-printed. Null once
   * every captured body carrying it has aged out — the sidecar keeps the tool's
   * size forever, but only a body holds its text.
   */
  schema: string | null;
  /** Wire bytes of this one definition, from the newest sidecar that carried it. */
  bytes: number;
  estTokens: number;
  /** Requests in the window that shipped this tool. */
  requests: number;
  /** This tool's share of every tool byte in the window, 0–1. */
  shareOfToolBytes: number;
  /** The request the schema was read back from; null when none survives. */
  file: string | null;
  meta: { days: number; files: number; parseErrors: number; candidates: number };
}

/** Bodies to open before giving up on recovering a tool's schema. */
const SCHEMA_BODY_TRIES = 8;

/**
 * One line item of the fixed prefix, opened up to the JSON behind it — the text
 * a tool's size is made of, where the tool table shows only the size.
 *
 * Like a prompt section, the schema has to come back from a captured body, so it
 * comes back null rather than erroring once the bodies have been evicted.
 */
export async function buildToolSchema(
  logDir: string,
  name: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ToolSchemaResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(
    logDir,
    { sinceDays: days, includeFile: true },
    now,
  );

  const candidates = new Set<string>();
  let requests = 0;
  let bytes = 0;
  let estTokens = 0;
  let toolBytesTotal = 0;
  let namedBytesTotal = 0;

  for (const s of sidecars) {
    if (!isAuditSidecar(s)) continue;
    for (const t of s.tools) toolBytesTotal += t.bytes;
    const hit = s.tools.find((t) => t.name === name);
    if (!hit) continue;
    requests += 1;
    namedBytesTotal += hit.bytes;
    // Sidecars arrive newest-last, so the last writer wins — the current size.
    bytes = hit.bytes;
    estTokens = hit.estTokens;
    const file = (s as { __file?: unknown }).__file;
    if (typeof file === 'string') candidates.add(file);
  }

  // Newest first: names lead with their timestamp, and a recent body is the
  // likeliest to still be on disk.
  const ordered = [...candidates].sort().reverse();

  let schema: string | null = null;
  let file: string | null = null;
  for (const candidate of ordered.slice(0, SCHEMA_BODY_TRIES)) {
    try {
      const { body } = await readRequestBody(logDir, candidate);
      const tools = (body as { tools?: unknown }).tools;
      if (!Array.isArray(tools)) continue;
      const found = tools.find((t) => (t as { name?: unknown })?.name === name);
      if (found === undefined) continue;
      schema = JSON.stringify(found, null, 2);
      file = candidate;
      break;
    } catch {
      // An unreadable or truncated body is one fewer candidate, not a failure:
      // the next-newest request carries the same definition.
    }
  }

  return {
    name,
    schema,
    bytes,
    estTokens,
    requests,
    shareOfToolBytes: toolBytesTotal > 0 ? namedBytesTotal / toolBytesTotal : 0,
    file,
    meta: { days, files, parseErrors, candidates: ordered.length },
  };
}

export interface ContextResponse {
  summary: ContextSummary;
  meta: { days: number; files: number; parseErrors: number };
}

/**
 * Sidecars read with `includeFile: true`, reduced to the context entries that
 * parsed. A sidecar with no `__file` handle has nothing to drill into, so it is
 * dropped.
 */
function toContextEntries(sidecars: readonly unknown[]): ContextEntry[] {
  const entries: ContextEntry[] = [];
  for (const s of sidecars) {
    const file = (s as { __file?: string }).__file;
    const entry = file ? toContextEntry(s, file) : null;
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Context-size analytics over the last `days` days: average / median / max real
 * input tokens, plus the largest requests (each with a `file` handle for the
 * drill-down). Reads only `.audit.json` sidecars — same cost as the trends view.
 */
export async function buildContext(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<ContextResponse> {
  const { sidecars, files, parseErrors } = await source.readSidecars(
    logDir,
    { sinceDays: days, includeFile: true },
    now,
  );
  return { summary: summarizeContext(toContextEntries(sidecars)), meta: { days, files, parseErrors } };
}

/**
 * What every body-reading drill-down answers when retention has evicted the body
 * it would have parsed. A normal terminal state, not an error: the sidecar is
 * kept, so only the verbatim text is gone.
 */
export interface EvictedBodyResponse {
  file: string;
  evicted: true;
  /** The archived day the sidecar was filed under; `null` if it is still live. */
  day: string | null;
  /** The window bodies are kept for, so the UI can name it rather than assume it. */
  retentionDays: number;
  /** Everything the audit sidecar retains; `null` only if it is unreadable. */
  retained: AuditSidecar | null;
}

/**
 * Turn a location into the evicted response, or throw for `missing` (a 404).
 * Returns `null` when the body is present and the caller should just read it.
 */
async function evictedOr404(
  logDir: string,
  file: string,
  location: RequestBodyLocation,
): Promise<EvictedBodyResponse | null> {
  if (location.status === 'present') return null;
  if (location.status === 'missing') throw new Error(`request file not found: ${file}`);
  return {
    file,
    evicted: true,
    day: location.day,
    retentionDays: resolveRetentionDays(),
    retained: await readRetainedSidecar(logDir, file, location.dir),
  };
}

export interface ContextDetailPresent {
  file: string;
  evicted: false;
  breakdown: RequestBreakdown;
  /** Full request JSON, pretty-printed (possibly truncated). */
  raw: string;
  truncated: boolean;
}

export type ContextDetailResponse = ContextDetailPresent | EvictedBodyResponse;

/**
 * The "why was it so large?" drill-down for one captured request: its
 * system/tools/message breakdown plus the raw request JSON. Reads exactly one
 * `.request.txt`, from the live directory or its archived day. `file` is validated
 * in {@link locateRequestBody}. Answers {@link EvictedBodyResponse} once retention
 * has evicted the body.
 */
export async function buildContextDetail(logDir: string, file: string): Promise<ContextDetailResponse> {
  const location = await locateRequestBody(logDir, file);
  const evicted = await evictedOr404(logDir, file, location);
  if (evicted) return evicted;

  const { body, raw, truncated } = await readRequestBody(logDir, file);
  return { file, evicted: false, breakdown: analyzeRequestBody(body), raw, truncated };
}

export interface ContextMessagePresent {
  file: string;
  evicted: false;
  message: RequestMessageDetail;
}

export type ContextMessageResponse = ContextMessagePresent | EvictedBodyResponse;

/**
 * The full content of one conversation message from a captured request. Reads
 * exactly one `.request.txt` (via {@link readRequestBody}, which validates
 * `file`) and slices out message `index`. The parsed body is always complete
 * even when the drill-down's raw JSON was truncated, so any message resolves.
 * Throws a labelled error the server maps to 404 when `index` is out of range.
 */
export async function buildContextMessage(
  logDir: string,
  file: string,
  index: number,
): Promise<ContextMessageResponse> {
  const location = await locateRequestBody(logDir, file);
  const evicted = await evictedOr404(logDir, file, location);
  if (evicted) return evicted;

  const { body } = await readRequestBody(logDir, file);
  const message = extractRequestMessage(body, index);
  if (!message) throw new Error(`message index out of range: ${index}`);
  return { file, evicted: false, message };
}

export interface ContextToolPresent {
  file: string;
  evicted: false;
  tool: RequestToolDetail;
}

export type ContextToolResponse = ContextToolPresent | EvictedBodyResponse;

/**
 * The full schema of one tool from a captured request. Reads exactly one
 * `.request.txt` (via {@link readRequestBody}, which validates `file`) and
 * slices out tool `index`. The parsed body is always complete even when the
 * drill-down's raw JSON was truncated, so any tool resolves. Throws a labelled
 * error the server maps to 404 when `index` is out of range.
 */
export async function buildContextTool(logDir: string, file: string, index: number): Promise<ContextToolResponse> {
  const location = await locateRequestBody(logDir, file);
  const evicted = await evictedOr404(logDir, file, location);
  if (evicted) return evicted;

  const { body } = await readRequestBody(logDir, file);
  const tool = extractRequestTool(body, index);
  if (!tool) throw new Error(`tool index out of range: ${index}`);
  return { file, evicted: false, tool };
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  meta: { projectsDir: string; total: number };
}

/** Every Claude Code project that has a `memory/` dir, with its memory count. */
export async function buildProjects(projectsDir: string): Promise<ProjectsResponse> {
  const projects = await listProjects(projectsDir);
  return { projects, meta: { projectsDir, total: projects.length } };
}

export interface ProjectMemoriesResponse {
  project: string;
  files: MemoryFileSummary[];
  meta: { total: number };
}

/** The `*.md` memory files for one project. `project` is validated downstream. */
export async function buildProjectMemories(projectsDir: string, project: string): Promise<ProjectMemoriesResponse> {
  const files = await listProjectMemories(projectsDir, project);
  return { project, files, meta: { total: files.length } };
}

export interface MemoryResponse {
  memory: MemoryDetail;
}

/** One memory file's full contents. `project`/`name` are validated downstream. */
export async function buildMemory(projectsDir: string, project: string, name: string): Promise<MemoryResponse> {
  return { memory: await readMemory(projectsDir, project, name) };
}

export interface JobsResponse {
  jobs: JobSummary[];
  meta: {
    jobsDir: string;
    total: number;
    /** How many are in a `busy` state right now. */
    running: number;
    /** Directories with no readable `state.json` — scratch space outliving its job. */
    husks: number;
    /** Files across every job, and their total bytes. */
    files: number;
    bytes: number;
  };
}

/**
 * Every background job directory on the device, newest activity first. A device
 * view, not a traffic one: these directories are Claude Code's own scratch space,
 * so nothing here comes from the captured logs.
 */
export async function buildJobs(jobsDir: string): Promise<JobsResponse> {
  const jobs = await listJobs(jobsDir);
  return {
    jobs,
    meta: {
      jobsDir,
      total: jobs.length,
      running: jobs.filter((j) => jobStateTone(j.state) === 'busy').length,
      husks: jobs.filter((j) => !j.stateReadable).length,
      files: jobs.reduce((sum, j) => sum + j.files, 0),
      bytes: jobs.reduce((sum, j) => sum + j.bytes, 0),
    },
  };
}

export interface JobResponse {
  job: JobSummary;
  /** The job directory as a folder tree, directories before files. */
  tree: JobTreeNode[];
  meta: { entries: number; truncated: boolean };
}

/** One job's state plus its folder tree. `id` is validated downstream. */
export async function buildJob(jobsDir: string, id: string): Promise<JobResponse> {
  const { job, tree } = await readJob(jobsDir, id);
  return { job, tree: tree.tree, meta: { entries: tree.entries, truncated: tree.truncated } };
}

export interface JobFileResponse {
  file: JobFileDetail;
}

/** One file inside a job directory, for the pretty/raw viewer. Both params are
 * validated downstream, where the path is also confirmed to stay inside the job. */
export async function buildJobFile(jobsDir: string, id: string, file: string): Promise<JobFileResponse> {
  return { file: await readJobFile(jobsDir, id, file) };
}

export interface JobDeleteResponse {
  deleted: JobDeleteResult;
  /** The listing as it stands after the delete. */
  jobs: JobsResponse;
}

/**
 * Delete one job directory from disk, then hand back the refreshed listing. `id` is
 * validated downstream, which also refuses a still-running job and a symlinked directory.
 */
export async function buildJobDelete(jobsDir: string, id: string): Promise<JobDeleteResponse> {
  const deleted = await deleteJob(jobsDir, id);
  return { deleted, jobs: await buildJobs(jobsDir) };
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript the proxy has written, newest first. */
export async function buildSessions(logDir: string, source: SidecarSource = fileSource): Promise<SessionsResponse> {
  const sessions = await source.listSessions(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export interface SessionsGraphResponse {
  sessions: SessionGraph[];
  meta: { sessionsDir: string; total: number };
}

/** Every session transcript with its structured node stream, newest first — feeds the live graph. */
export async function buildSessionsGraph(
  logDir: string,
  source: SidecarSource = fileSource,
): Promise<SessionsGraphResponse> {
  const sessions = await source.listSessionGraphs(logDir);
  return { sessions, meta: { sessionsDir: `${logDir}/sessions`, total: sessions.length } };
}

export type SessionNodeTextsResponse = SessionNodeTexts;

/**
 * The untruncated text behind one session's truncated node lines. Kept off the
 * polling `/api/sessions/graph`, where it would dwarf the gists. `id` is validated
 * downstream.
 */
export async function buildSessionNodeTexts(
  logDir: string,
  id: string,
  source: SidecarSource = fileSource,
): Promise<SessionNodeTextsResponse> {
  return source.readSessionNodeTexts(logDir, id);
}

export interface SessionResponse {
  session: SessionDetail;
}

/** One session transcript's full contents. `id` is validated downstream. */
export async function buildSession(
  logDir: string,
  id: string,
  source: SidecarSource = fileSource,
): Promise<SessionResponse> {
  return { session: await source.readSession(logDir, id) };
}

export interface SessionErrorsResponse {
  threadId: string;
  meta: SessionMeta;
  errors: LinkedSessionError[];
}

/**
 * Every errored tool result in one session, re-linked to its task and tool call, and
 * where possible to the request message that holds the failed turn. Reuses
 * {@link readSession}, which validates `id` and maps to 400/404.
 *
 * An error the session's captures can't account for comes back with no link rather
 * than failing the page.
 */
export async function buildSessionErrors(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionErrorsResponse> {
  const { meta, content } = await source.readSession(logDir, id);
  const errors = parseSessionErrors(content);
  const { requests } = await resolveSessionRequests(logDir, meta, now, source);
  const links = await linkErrorsToRequests(logDir, requests, errors);

  return { threadId: id, meta, errors: errors.map((error, i) => ({ ...error, link: links[i] ?? null })) };
}

/**
 * How many request bodies one errors page will open — a busy session captures hundreds,
 * each up to megabytes of JSON. See {@link requestsToScan} for which ones.
 */
const MAX_ERROR_REQUEST_SCANS = 6;

/**
 * Find the request message behind each error. Each body links whichever errors it can
 * and later ones only fill the gaps, so different errors can point at different
 * requests, and the scan stops once every error has a home.
 */
async function linkErrorsToRequests(
  logDir: string,
  requests: readonly ContextEntry[],
  errors: readonly SessionError[],
): Promise<(SessionErrorLink | null)[]> {
  const links: (SessionErrorLink | null)[] = errors.map(() => null);
  if (errors.length === 0) return links;

  for (const request of requestsToScan(requests)) {
    const sites = await readRequestErrorSites(logDir, request.file);
    if (sites.length === 0) continue;

    const found = linkRequestErrors(errors, sites);
    let unlinked = 0;
    for (let i = 0; i < links.length; i += 1) {
      const messageIndex = found[i];
      if (links[i] === null && messageIndex != null) links[i] = { file: request.file, messageIndex };
      if (links[i] === null) unlinked += 1;
    }
    if (unlinked === 0) break;
  }
  return links;
}

/**
 * Which of a session's requests to open: the peak, then an even walk along the
 * session's timeline.
 *
 * Taking the largest few instead is the wrong shape: the biggest bodies cluster at the
 * end of a run and, once a session has compacted, are precisely the ones that have
 * dropped its early failures — on a 193-request session the only body still holding the
 * first error ranked 43rd by size. Errors are spread through a session, so sampling its
 * timeline reaches them in far fewer reads. The peak leads as the body most likely to
 * carry a turn at all.
 */
export function requestsToScan(requests: readonly ContextEntry[]): ContextEntry[] {
  if (requests.length === 0) return [];

  const byTime = [...requests].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const picked = [requests.reduce((max, e) => (e.realInput > max.realInput ? e : max))];
  const take = (entry: ContextEntry): void => {
    if (!picked.some((p) => p.file === entry.file)) picked.push(entry);
  };

  const samples = MAX_ERROR_REQUEST_SCANS - 1;
  for (let i = 1; i <= samples; i += 1) take(byTime[Math.round((i / samples) * (byTime.length - 1))]!);

  // A set inside the budget repeats samples, so the rest of the timeline fills the
  // spare reads. Order stays peak-first, the same shape a large set is scanned in.
  if (requests.length <= MAX_ERROR_REQUEST_SCANS) for (const entry of byTime) take(entry);
  return picked;
}

/** A captured request's errored tool results, or none when the body has gone or won't parse. */
async function readRequestErrorSites(logDir: string, file: string): Promise<RequestErrorSite[]> {
  try {
    const { body } = await readRequestBody(logDir, file);
    return deriveRequestErrors(body);
  } catch {
    return [];
  }
}

export interface SessionBreakdownResponse extends SessionContextPeak {
  threadId: string;
  /** The Claude Code session id the requests were matched on; null if the transcript has none. */
  sessionId: string | null;
  meta: { files: number; parseErrors: number };
}

/**
 * Every request sent under a session's id, plus the largest of them and the sidecar
 * counts behind the scan. Reads from the session's start date onward — a session's
 * requests never predate it — or the whole log when it has no start. A transcript with
 * no session id has nothing to match on and scans nothing.
 */
async function resolveSessionRequests(
  logDir: string,
  meta: SessionMeta,
  now: Date,
  source: SidecarSource,
): Promise<
  SessionContextPeak & { sessionId: string | null; requests: ContextEntry[]; files: number; parseErrors: number }
> {
  const sessionId = meta.sessionId;
  if (!sessionId) {
    return { sessionId: null, requests: [], requestCount: 0, peak: null, files: 0, parseErrors: 0 };
  }

  const since = (meta.started && reportDay(meta.started)) || undefined;
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const entries = toContextEntries(sidecars);

  return {
    sessionId,
    requests: entries.filter((e) => e.sessionId === sessionId),
    ...sessionContextPeak(entries, sessionId),
    files,
    parseErrors,
  };
}

/**
 * The captured request a session links to for its breakdown: the largest one sent
 * under its session id.
 */
export async function buildSessionBreakdown(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionBreakdownResponse> {
  const { meta } = await source.readSession(logDir, id);
  const { sessionId, requestCount, peak, files, parseErrors } = await resolveSessionRequests(logDir, meta, now, source);

  return { threadId: id, sessionId, requestCount, peak, meta: { files, parseErrors } };
}

export interface SessionSuggestionsResponse {
  buckets: SessionBucket[];
  meta: { sessionsDir: string; sessions: number; buckets: number };
}

/**
 * Every ten-session window, newest first, with what its transcripts say about
 * reaching the same outcome in fewer steps. Recomputed from every transcript on
 * each call — there is no backfill state to keep in sync.
 */
export async function buildSessionSuggestions(
  logDir: string,
  source: SidecarSource = fileSource,
): Promise<SessionSuggestionsResponse> {
  const sessions = await source.listSessionGraphs(logDir);
  const buckets = sessionSuggestionBuckets(sessions);
  return {
    buckets,
    meta: { sessionsDir: `${logDir}/sessions`, sessions: sessions.length, buckets: buckets.length },
  };
}

export interface SessionSuggestionBucketResponse {
  bucket: SessionBucket;
  /** The transcripts it covers, oldest first — the drill-down's session list. */
  sessions: SessionSummary[];
  /** What the bucket's peak requests are made of, and what repeats across them. */
  breakdown: BucketBreakdownSummary;
  /** Suggestions the breakdown supports that the transcripts alone cannot. */
  breakdownSuggestions: SessionSuggestion[];
  meta: { files: number; parseErrors: number; requestsMissing: number };
}

/**
 * One bucket's drill-down: its suggestions, the sessions behind them, and the
 * Request Breakdown patterns that recur across those sessions' largest captured
 * requests. Each session contributes at most one request (its peak), so the
 * pattern roll-up compares like with like and reads at most ten request bodies.
 * Throws a labelled error the server maps to 404 when `index` names no bucket.
 */
export async function buildSessionSuggestionBucket(
  logDir: string,
  index: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionSuggestionBucketResponse> {
  const graphs = await source.listSessionGraphs(logDir);
  const bucket = sessionSuggestionBuckets(graphs).find((b) => b.index === index);
  if (!bucket) throw new Error(`suggestion bucket not found: ${index}`);

  const byThread = new Map(graphs.map((g) => [g.threadId, g]));
  // Bucket order is the authority on which sessions belong and in what order.
  const sessions = bucket.threadIds
    .map((id) => byThread.get(id))
    .filter((g): g is (typeof graphs)[number] => !!g)
    .map(({ nodes: _nodes, ...row }) => row as SessionSummary);

  // A session's requests never predate it, so the earliest start bounds the scan.
  const since = (bucket.startedFirst && reportDay(bucket.startedFirst)) || undefined;
  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const entries = toContextEntries(sidecars);

  const peaks = sessions
    .map((s) => ({ threadId: s.threadId, peak: sessionContextPeak(entries, s.sessionId).peak }))
    .filter((p): p is { threadId: string; peak: ContextEntry } => !!p.peak);

  const inputs: BucketBreakdownInput[] = [];
  for (const { threadId, peak } of peaks) {
    try {
      const { body } = await readRequestBody(logDir, peak.file);
      inputs.push({ threadId, file: peak.file, realInput: peak.realInput, breakdown: analyzeRequestBody(body) });
    } catch {
      // The sidecar outlived its captured body (retention) — the rest still summarizes.
    }
  }

  const breakdown = summarizeBreakdownPatterns(inputs);
  return {
    bucket,
    sessions,
    breakdown,
    breakdownSuggestions: suggestFromBreakdown(breakdown),
    meta: { files, parseErrors, requestsMissing: sessions.length - inputs.length },
  };
}

export interface SuggestionStatusResponse {
  rows: SuggestionStatusRow[];
  meta: {
    /** Where the flags are stored. */
    statusFile: string;
    /** Bucket indexes that exist, ascending — what a range can name. */
    buckets: number[];
    /** Bucket indexes the caller asked for that don't exist, if any. */
    missing: number[];
    /** Row counts per flag, over the rows returned. */
    counts: Record<SuggestionStatus, number>;
    /** Row counts per recurrence state, over the rows returned. */
    recurrences: Record<SuggestionRecurrence, number>;
    /**
     * Bucket counts per judgement state, over **every** bucket rather than the rows
     * returned: how much of the corpus is unadjudicated is not a fact about the slice.
     */
    bucketStates: Record<BucketJudgementState, number>;
  };
}

/**
 * The lean status list: every suggestion in the requested buckets with its flag,
 * oldest bucket first. This is the list an agent reads to find what is still
 * `pending` in a range of buckets without pulling each bucket's full drill-down —
 * the row carries only what it takes to decide and the handle to mark it after.
 *
 * `buckets` omitted means every bucket; `statuses` omitted means all three flags;
 * `recurrences` omitted means all four states. `detail` adds each suggestion's
 * detail, evidence and sources — what a caller about to act on one needs, at the
 * cost of a much larger response.
 */
export async function buildSuggestionStatus(
  logDir: string,
  filter: {
    buckets?: readonly number[];
    statuses?: readonly SuggestionStatus[];
    recurrences?: readonly SuggestionRecurrence[];
    detail?: boolean;
  } = {},
  source: SidecarSource = fileSource,
): Promise<SuggestionStatusResponse> {
  // Only the *derived* half goes through the seam. The status store is authored
  // state, so it stays a JSON file read directly on both sides of parity.
  const [sessions, store] = await Promise.all([source.listSessionGraphs(logDir), readSuggestionStatusStore(logDir)]);
  const buckets = sessionSuggestionBuckets(sessions);
  const existing = buckets.map((b) => b.index).sort((a, b) => a - b);
  const rows = suggestionStatusRows(buckets, store, filter);
  return {
    rows,
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      buckets: existing,
      missing: (filter.buckets ?? []).filter((i) => !existing.includes(i)),
      counts: countSuggestionStatuses(rows),
      recurrences: countSuggestionRecurrences(rows),
      bucketStates: countBucketJudgementStates(bucketJudgements(buckets, store)),
    },
  };
}

export interface SuggestionBucketsResponse {
  buckets: BucketJudgementRow[];
  meta: {
    statusFile: string;
    /** Bucket counts per judgement state, over every bucket that exists. */
    states: Record<BucketJudgementState, number>;
  };
}

/**
 * Every bucket with its complete / judged / dirty state — the list a judge reads to
 * find what is still worth adjudicating. `dirty` narrows it to exactly that: the
 * complete windows with no verdict on record.
 */
export async function buildSuggestionBuckets(
  logDir: string,
  filter: { dirty?: boolean } = {},
  source: SidecarSource = fileSource,
): Promise<SuggestionBucketsResponse> {
  const [sessions, store] = await Promise.all([source.listSessionGraphs(logDir), readSuggestionStatusStore(logDir)]);
  const all = bucketJudgements(sessionSuggestionBuckets(sessions), store);
  return {
    buckets: filter.dirty ? all.filter((b) => b.state === 'dirty') : all,
    // Counted over every bucket: the point of the header is what is left overall.
    meta: { statusFile: resolveSuggestionStatusPath(logDir), states: countBucketJudgementStates(all) },
  };
}

export interface RuleDefectsResponse {
  defects: RuleDefect[];
  meta: {
    statusFile: string;
    /** Complete buckets the ratios were measured over. */
    buckets: number;
    /** The thresholds that were applied, so a report reads without the source. */
    thresholds: { minDismissedBuckets: number; minDismissedRatio: number };
  };
}

/**
 * Rules dismissed often enough to indict the rule rather than the window. Pure
 * arithmetic over the store and the recomputed buckets — nothing is cached, so a
 * dismissal recorded a second ago is in the next report.
 */
export async function buildRuleDefects(
  logDir: string,
  source: SidecarSource = fileSource,
): Promise<RuleDefectsResponse> {
  const [sessions, store] = await Promise.all([source.listSessionGraphs(logDir), readSuggestionStatusStore(logDir)]);
  const buckets = sessionSuggestionBuckets(sessions);
  return {
    defects: ruleDefects(buckets, store),
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      buckets: buckets.filter((b) => b.complete).length,
      thresholds: { ...SUGGESTION_DEFECT_THRESHOLDS },
    },
  };
}

export interface SuggestionStatusUpdateResponse {
  /** The updated rows, re-read through the same join the list uses. */
  rows: SuggestionStatusRow[];
  meta: { statusFile: string; updated: number; unknown: { bucket: number; id: string }[] };
}

/**
 * Set key for a bucket/id pair. Neither a number nor an id can contain a unit
 * separator, so two equal keys mean a genuinely equal pair.
 */
const suggestionKey = (v: { bucket: number; id: string }): string => `${v.bucket}\u001f${v.id}`;

/**
 * Record flags for suggestions. Every update is applied — a suggestion whose rule
 * has since stopped tripping keeps its flag rather than being dropped, so marking
 * something done is not undone by the next recomputation. Updates naming a
 * bucket/id pair no suggestion currently carries are still written, and reported
 * under `unknown` so a typo is visible instead of silent.
 */
export async function applySuggestionStatus(
  logDir: string,
  updates: readonly SuggestionStatusUpdate[],
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SuggestionStatusUpdateResponse> {
  if (updates.length === 0) throw new Error('no suggestion status updates given');
  const store = await updateSuggestionStatusStore(logDir, updates, now);
  const buckets = sessionSuggestionBuckets(await source.listSessionGraphs(logDir));
  const touched = [...new Set(updates.map((u) => u.bucket))];
  const rows = suggestionStatusRows(buckets, store, { buckets: touched });
  const known = new Set(rows.map((r) => suggestionKey(r)));
  return {
    rows: rows.filter((r) => updates.some((u) => u.bucket === r.bucket && u.id === r.id)),
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      updated: updates.length,
      unknown: updates.filter((u) => !known.has(suggestionKey(u))).map((u) => ({ bucket: u.bucket, id: u.id })),
    },
  };
}

/** A judge's verdict on one pass, as the API and the CLI both express it. */
export interface SuggestionJudgeRequest {
  /** The status writes it decided on — the dismissals, and anything else. */
  updates?: readonly SuggestionStatusUpdate[];
  /** The buckets it adjudicated, with the enrichment notes it recorded. */
  judged?: readonly SuggestionJudgementWrite[];
  /**
   * Mark every currently **dirty** bucket judged, with no notes — the line drawn
   * under a backlog of unjudged windows rather than a claim that each was read.
   * Already-clean buckets are left alone, so amnesty can never delete enrichment a
   * judge wrote. Combined with `judged`, the explicit records win.
   */
  amnesty?: boolean;
}

export interface SuggestionJudgeResponse {
  /** The rows in every bucket the verdict touched, re-read through the list's own join. */
  rows: SuggestionStatusRow[];
  /** Those buckets' judgement states after the write. */
  buckets: BucketJudgementRow[];
  meta: {
    statusFile: string;
    /** Status flags written. */
    updated: number;
    /** Buckets recorded as judged. */
    judged: number;
    /** Bucket/id pairs no suggestion currently carries — written anyway, so a typo shows. */
    unknown: { bucket: number; id: string }[];
    /** Bucket counts per judgement state, over every bucket, after the write. */
    states: Record<BucketJudgementState, number>;
  };
}

/**
 * Record a judge's verdict: the dismissals and the per-bucket judgement records, in
 * one atomic file write.
 *
 * Two things are refused rather than recorded:
 *
 * - **A corpus that cannot be bucketed stably.** A session with no `started` shifts
 *   every bucket boundary after it, so verdicts already on file would come to
 *   describe sessions they never examined. {@link assertJudgeableCorpus} names them.
 * - **An incomplete bucket.** A partial window still gains sessions, so a verdict
 *   against it is a verdict against evidence that has not finished arriving.
 */
export async function applySuggestionJudge(
  logDir: string,
  request: SuggestionJudgeRequest,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SuggestionJudgeResponse> {
  const sessions = await source.listSessionGraphs(logDir);
  assertJudgeableCorpus(sessions);
  const buckets = sessionSuggestionBuckets(sessions);
  const complete = new Map(buckets.filter((b) => b.complete).map((b) => [b.index, b]));

  const explicit = request.judged ?? [];
  // Amnesty covers only the *dirty* buckets. A clean one is already judged, and
  // re-recording it with no notes would delete enrichment a judge actually wrote —
  // amnesty draws a line under a backlog, it does not overwrite verdicts.
  const store0 = await readSuggestionStatusStore(logDir);
  const judged: SuggestionJudgementWrite[] = request.amnesty
    ? [
        ...[...complete.values()]
          .filter((b) => bucketJudgementState(b, store0) === 'dirty' && !explicit.some((w) => w.bucket === b.index))
          .map((b) => ({ bucket: b.index })),
        ...explicit,
      ]
    : [...explicit];
  const updates = request.updates ?? [];
  if (judged.length === 0 && updates.length === 0) throw new Error('nothing to judge: no updates and no buckets');

  // Both halves are refused on the same ground, so check them together and name
  // every offending bucket at once rather than one per retry.
  const partial = [...new Set([...judged.map((w) => w.bucket), ...updates.map((u) => u.bucket)])]
    .filter((i) => !complete.has(i))
    .sort((a, b) => a - b);
  if (partial.length > 0) {
    throw new Error(
      `refusing to judge incomplete bucket${partial.length === 1 ? '' : 's'} ${partial.join(', ')}: ` +
        `only a window holding its full ${SESSION_BUCKET_SIZE} sessions has membership that cannot still change`,
    );
  }

  const store = await judgeSuggestionStatusStore(logDir, { updates, judged }, now);
  const touched = [...new Set([...judged.map((w) => w.bucket), ...updates.map((u) => u.bucket)])];
  const rows = suggestionStatusRows(buckets, store, { buckets: touched });
  const known = new Set(rows.map((r) => suggestionKey(r)));
  const states = bucketJudgements(buckets, store);
  return {
    rows,
    buckets: states.filter((b) => touched.includes(b.bucket)),
    meta: {
      statusFile: resolveSuggestionStatusPath(logDir),
      updated: updates.length,
      judged: judged.length,
      unknown: updates.filter((u) => !known.has(suggestionKey(u))).map((u) => ({ bucket: u.bucket, id: u.id })),
      states: countBucketJudgementStates(states),
    },
  };
}

export interface IdeasResponse {
  /** Oldest first — the order the ledger was decided in. */
  rows: IdeaEntry[];
  meta: {
    /** Where the ledger is stored. */
    file: string;
    /** Row counts per status, over the rows returned. */
    counts: Record<IdeaStatus, number>;
    /** Entries on the whole ledger, so a filtered view still says how much it hid. */
    total: number;
  };
}

/**
 * The ideas ledger over HTTP — the read half of what `pnpm --filter server ideas
 * list` prints.
 *
 * Takes no `SidecarSource` and is not shadowed, unlike
 * {@link buildSuggestionStatus}: an idea is *authored*, existing only in
 * `ideas.json`, so there is no derived half to compare across the parity seam.
 * Nothing here reads the suggestion store.
 *
 * A ledger that exists but does not parse throws — see `readIdeasStore` — and
 * the route lets that surface as a 500 rather than answering with an empty
 * ledger a caller would re-propose everything into.
 */
export async function buildIdeas(logDir: string, filter: IdeaFilter = {}): Promise<IdeasResponse> {
  const store = await readIdeasStore(logDir);
  const rows = ideaRows(store, filter);
  return {
    rows,
    meta: {
      file: resolveIdeasPath(logDir),
      counts: countIdeaStatuses(rows),
      total: Object.keys(store.ideas).length,
    },
  };
}

/**
 * The statuses a browser may set.
 *
 * `shipped` is deliberately absent — it carries a PR url and is a claim made by
 * whoever landed the change, so it stays with the CLI. `proposed` is the undo: it
 * restores an idea to unsigned-off without erasing the entry or its note.
 */
export const BROWSER_IDEA_STATUSES = ['proposed', 'accepted', 'rejected'] as const;

export interface IdeasStatusResponse {
  /** The entries the write touched, as they now stand. */
  rows: IdeaEntry[];
  meta: {
    file: string;
    updated: string[];
    /** Slugs no entry carries. Nothing was written for these — a mark on an absent slug is a typo. */
    unknown: string[];
    /** Row counts per status over the whole ledger, so a card can say what `/improve` will pick up. */
    counts: Record<IdeaStatus, number>;
    total: number;
  };
}

/**
 * Adjudicate ideas from the dashboard. Two refusals are enforced here rather
 * than in the route, so the HTTP contract cannot drift from the CLI's:
 *
 * - **`shipped` is refused**, per {@link BROWSER_IDEA_STATUSES}.
 * - **A `rejected` mark with no note is refused.** The reason is the ledger's
 *   dedupe record, and an empty one looks like a decision while carrying nothing
 *   a later reader can act on.
 */
export async function applyIdeaStatus(
  logDir: string,
  marks: readonly IdeaMark[],
  now: Date = new Date(),
): Promise<IdeasStatusResponse> {
  if (marks.length === 0) throw new Error('no idea marks given');
  for (const mark of marks) {
    if (!(BROWSER_IDEA_STATUSES as readonly IdeaStatus[]).includes(mark.status)) {
      throw new Error(
        `${mark.status} cannot be set from the dashboard (${BROWSER_IDEA_STATUSES.join(', ')} only): ` +
          'it carries a PR url, so it stays with `ideas mark`',
      );
    }
    if (mark.status === 'rejected' && !mark.note?.trim()) {
      throw new Error(
        `rejecting ${mark.slug} needs a reason: it is the ledger's record of why, and what stops the idea being re-proposed`,
      );
    }
  }

  const result = await markIdeasInStore(logDir, marks, now);
  const touched = new Set(result.updated);
  const all = ideaRows(result.store);
  return {
    rows: all.filter((row) => touched.has(row.slug)),
    meta: {
      file: result.file,
      updated: result.updated,
      unknown: result.unknown,
      // Over the whole ledger rather than the rows returned: what is still awaiting a
      // sign-off is not a fact about the write that just happened.
      counts: countIdeaStatuses(all),
      total: all.length,
    },
  };
}

/** One transcript's steps, re-read from the captured request that carries them whole. */
export interface SessionThreadNodes {
  threadId: string;
  /** Sidecar base name of the request the nodes came from — the Request breakdown handle. */
  file: string;
  /** How many messages that request carried, i.e. how deep a snapshot this is. */
  messageCount: number;
  nodes: SessionNode[];
}

export interface SessionGraphNodesResponse {
  rootThreadId: string;
  /** Only the threads a captured request could be found for; the rest keep their transcript. */
  threads: SessionThreadNodes[];
  meta: { files: number; parseErrors: number; requestsRead: number; capped: boolean };
}

/**
 * How many captured requests one family scan will read and parse. Each is a whole request
 * body, so the cap bounds a graph load; the scan is newest-first, so the budget goes to the
 * window the family was active in.
 */
const MAX_FAMILY_REQUESTS = 60;

/**
 * The untruncated step stream for a canvased session and every subagent under it: scan the
 * sidecars carrying the family's session ids newest-first, hash each body back to the thread
 * that produced it, and keep the richest snapshot per thread. Threads with no captured
 * request left go unlisted, and the caller keeps their transcript nodes.
 */
export async function buildSessionGraphNodes(
  logDir: string,
  id: string,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SessionGraphNodesResponse> {
  const graphs = await source.listSessionGraphs(logDir);
  const byId = new Map(graphs.map((g) => [g.threadId, g]));
  if (!byId.has(id)) throw new Error(`session not found: ${id}`);

  // The canvased session plus every descendant — one agent family.
  const family = new Set<string>();
  const walk = (threadId: string) => {
    if (family.has(threadId)) return;
    family.add(threadId);
    for (const kid of byId.get(threadId)?.childThreadIds ?? []) walk(kid);
  };
  walk(id);

  const sessionIds = new Set([...family].map((t) => byId.get(t)?.sessionId).filter((s): s is string => !!s));
  if (sessionIds.size === 0) {
    return { rootThreadId: id, threads: [], meta: { files: 0, parseErrors: 0, requestsRead: 0, capped: false } };
  }

  // A family's requests never predate its earliest transcript, and `readSidecars`
  // narrows by *reporting* day, so the floor is derived on that clock too.
  const starts = [...family].map((t) => byId.get(t)?.started).filter((s): s is string => !!s);
  const since = (starts.length > 0 && reportDay(starts.sort()[0]!)) || undefined;

  const { sidecars, files, parseErrors } = await source.readSidecars(logDir, { since, includeFile: true }, now);
  const candidates = toContextEntries(sidecars)
    .filter((e) => e.sessionId !== null && sessionIds.has(e.sessionId))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, MAX_FAMILY_REQUESTS);

  const best = new Map<string, SessionThreadNodes>();
  let requestsRead = 0;
  for (const entry of candidates) {
    let body: unknown;
    try {
      ({ body } = await readRequestBody(logDir, entry.file));
    } catch {
      continue; // request log rotated away or never landed — the sidecar still counts
    }
    requestsRead += 1;

    const threadId = threadIdForBody(entry.sessionId, (body as { messages?: unknown } | null)?.messages);
    if (!threadId || !family.has(threadId)) continue;

    const messageCount = Array.isArray((body as { messages?: unknown }).messages)
      ? ((body as { messages: unknown[] }).messages.length ?? 0)
      : 0;
    const prev = best.get(threadId);
    if (prev && prev.messageCount >= messageCount) continue;
    best.set(threadId, { threadId, file: entry.file, messageCount, nodes: deriveSessionNodes(body) });
  }

  return {
    rootThreadId: id,
    threads: [...best.values()],
    meta: { files, parseErrors, requestsRead, capped: candidates.length === MAX_FAMILY_REQUESTS },
  };
}

export interface SkimResponse {
  date: string;
  skim: SkimDigest;
  /**
   * `bodiesEvicted` counts the sidecars here whose `.request.txt` is gone. Skim
   * parses bodies for the last user turn, so an evicted one otherwise reads as a
   * request that never had any text.
   */
  meta: { files: number; parseErrors: number; bodiesEvicted: number };
}

export async function buildSkim(
  logDir: string,
  date?: string,
  now: Date = new Date(),
  archiveDir?: string,
  source: SidecarSource = fileSource,
): Promise<SkimResponse> {
  const day = date ?? today(now);
  const { sidecars, files, parseErrors, bodiesEvicted } = await daySidecars(logDir, day, now, source, archiveDir, {
    includeSkimRequests: true,
  });
  const skim = computeSkimDigest(sidecars, { date: day, topN: 50 });
  return { date: day, skim, meta: { files, parseErrors, bodiesEvicted: bodiesEvicted ?? 0 } };
}

export interface SkimTrendResponse {
  digests: SkimDigest[];
  topShapes: SkimShape[];
  /** `bodiesEvicted` as in {@link SkimResponse}, across the whole window. */
  meta: { days: number; files: number; parseErrors: number; bodiesEvicted: number };
}

export async function buildSkimTrend(
  logDir: string,
  days: number,
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<SkimTrendResponse> {
  const { sidecars, files, parseErrors, bodiesEvicted } = await source.readSidecars(
    logDir,
    { sinceDays: days, includeSkimRequests: true },
    now,
  );
  const topShapes = computeSkimDigest(sidecars, { date: `${days}d`, topN: 50 }).topShapes;
  return {
    digests: skimDigestsByDay(sidecars),
    topShapes,
    meta: { days, files, parseErrors, bodiesEvicted: bodiesEvicted ?? 0 },
  };
}

export interface WithheldResponse {
  /** The device settings file the deny-list was read from (device-specific). */
  settingsPath: string;
  settingsReadable: boolean;
  report: WithheldReport;
  /** `claude*` launch aliases from the shell rc, the raw flags each parses, and
   * their net effective tool posture (cross-referencing the device deny list +
   * disable keys). Launch flags never reach the proxy, so this is computed from
   * settings precedence, not verified against traffic like the deny rules. */
  launchAliases: {
    rcPath: string;
    rcReadable: boolean;
    aliases: LaunchAlias[];
    posture: LaunchAliasPosture;
  };
  meta: { days: number; files: number; parseErrors: number };
}

/**
 * The device's withheld-tools policy: which tool schemas `~/.claude/settings.json`
 * keeps out of every request, cross-referenced with the last `days` of traffic
 * so we can confirm each is actually absent. This is a policy/verification view,
 * hence a window rather than a single day. Also surfaces the `claude*` launch
 * aliases from the shell rc, which withhold tools per-launch via
 * `--disallowedTools` (declarative — not traffic-verified).
 */
export async function buildWithheld(
  logDir: string,
  days: number,
  settingsPath: string = resolveSettingsPath(),
  now: Date = new Date(),
  source: SidecarSource = fileSource,
): Promise<WithheldResponse> {
  // The traffic half goes through the seam; the device settings and the shell rc
  // are authored files outside `logs/`, read the same way by both backings.
  const [{ sidecars, files, parseErrors }, settings, launchAliases] = await Promise.all([
    source.readSidecars(logDir, { sinceDays: days }, now),
    readDeviceSettings(settingsPath),
    readLaunchAliases(),
  ]);
  const report = withheldReport(sidecars, settings.denyRules, settings.enabledDisableKeys);
  const posture = computeAliasPosture(launchAliases.aliases, settings.denyRules, settings.enabledDisableKeys);
  return {
    settingsPath: settings.settingsPath,
    settingsReadable: settings.readable,
    report,
    launchAliases: { ...launchAliases, posture },
    meta: { days, files, parseErrors },
  };
}

export interface HooksPluginsResponse {
  /** The device settings file the hooks/plugins were read from. */
  settingsPath: string;
  settingsReadable: boolean;
  /** Configured hook commands, flattened from `settings.json` `hooks`. */
  hooks: HookRow[];
  /** Configured plugins, from `settings.json` `enabledPlugins`. */
  plugins: PluginRow[];
  /** Per `claude*` launch alias, whether user hooks/plugins are expected to load. */
  loadExpectations: AliasLoadExpectation[];
  /** The shell rc the launch aliases were read from (for the expectations section). */
  launchRcPath: string;
  launchRcReadable: boolean;
}

/**
 * The device's hooks & plugins configuration inventory, plus which launch modes are
 * expected to load them. Config view, not runtime: hooks have no API footprint, so
 * the proxy can't confirm one fired — only what `~/.claude/settings.json` declares.
 * Load expectations reuse the launch-alias posture.
 */
export async function buildHooksPlugins(settingsPath: string = resolveSettingsPath()): Promise<HooksPluginsResponse> {
  const [settings, launchAliases] = await Promise.all([readDeviceSettings(settingsPath), readLaunchAliases()]);
  const posture = computeAliasPosture(launchAliases.aliases, settings.denyRules, settings.enabledDisableKeys);
  return {
    settingsPath: settings.settingsPath,
    settingsReadable: settings.readable,
    hooks: flattenHooks(settings.hooks),
    plugins: normalizePlugins(settings.enabledPlugins),
    loadExpectations: hookPluginLoadExpectations(posture),
    launchRcPath: launchAliases.rcPath,
    launchRcReadable: launchAliases.rcReadable,
  };
}

export interface SystemPromptResponse {
  prompt: SystemPromptDoc;
  /** Ceiling the save route enforces, so the editor can show it before a refusal. */
  maxBytes: number;
}

/**
 * The device system prompt — `~/.claude/CLAUDE.md` as it is on disk right now.
 * A device view, not a traffic one: nothing here comes from the captured logs.
 */
export async function buildSystemPrompt(promptPath: string = resolveSystemPromptPath()): Promise<SystemPromptResponse> {
  const file = await readSystemPromptFile(promptPath);
  return {
    prompt: summarizeSystemPrompt({
      path: file.promptPath,
      exists: file.exists,
      text: file.text,
      modified: file.modified,
    }),
    maxBytes: SYSTEM_PROMPT_MAX_BYTES,
  };
}

export interface SystemPromptUpdateResponse extends SystemPromptResponse {
  /** The `.bak` holding the previous contents, or null on the save that created the file. */
  backupPath: string | null;
}

/**
 * Replace the device system prompt with `text` and answer with a fresh read of the
 * file, not an echo. Invalid input throws before anything is written.
 */
export async function buildSystemPromptUpdate(promptPath: string, text: unknown): Promise<SystemPromptUpdateResponse> {
  const written = await writeSystemPromptFile(promptPath, parseSystemPromptText(text));
  return {
    prompt: summarizeSystemPrompt({
      path: written.promptPath,
      exists: written.exists,
      text: written.text,
      modified: written.modified,
    }),
    maxBytes: SYSTEM_PROMPT_MAX_BYTES,
    backupPath: written.backupPath,
  };
}

/**
 * The proxy's request-filter inventory: what `proxy/proxy.ts` strips from every
 * request before forwarding. A static config view — these edits have no
 * per-request variation and can't be configured out of the CLI, so the proxy is
 * the only place they happen. Sourced from `PROXY_FILTER_INVENTORY` in core, which
 * mirrors the proxy's runtime constants.
 */
export function buildFilters(now: Date = new Date()): FiltersResponse {
  return { generatedAt: now.toISOString(), filters: PROXY_FILTER_INVENTORY };
}

export interface CommandsResponse {
  commands: CommandSummary[];
  meta: { commandsDir: string; storePath: string; runs: number; installed: number };
}

/**
 * The `/commands` index. Rows come from the installed catalogue unioned with every
 * command the store has runs for, so a command that a `/sync` removed keeps its history
 * instead of taking it off the page.
 */
export async function buildCommands(
  logDir: string,
  commandsDir: string,
  source: SidecarSource = fileSource,
): Promise<CommandsResponse> {
  const [installed, runs] = await Promise.all([listInstalledCommands(commandsDir), source.readCommandRuns(logDir)]);
  return {
    commands: summarizeCommands(installed, runs),
    meta: {
      commandsDir,
      storePath: `${logDir}/commands/runs.jsonl`,
      runs: runs.length,
      installed: installed.length,
    },
  };
}

/**
 * One run as the command page lists it: everything the scatter and the run list need,
 * without the per-turn series or the per-step breakdown, which only the detail view
 * reads and which dominate a record's size.
 */
export interface CommandRunListItem {
  /** The record's key, and the run route's param — see `runKey`. */
  runId: string;
  /** Set when this run was invoked by another; the row links back to it. */
  parentRunId: string | null;
  parentCommand: string | null;
  threadId: string;
  command: string;
  args: string;
  flags: string[];
  prompt: string;
  commandHash: string | null;
  model: string | null;
  started: string | null;
  ended: string | null;
  outcome: CommandRun['outcome'];
  interruption: CommandRun['interruption'];
  reachedEnd: boolean;
  totals: CommandRun['totals'];
  /** Which rules fired, for the run list's badges. The details stay on the run page. */
  patterns: CommandPattern['id'][];
  /** The furthest declared step anything was attributed to, or null. */
  lastStep: string | null;
  meta: CommandRun['meta'];
}

/** Where the command file's content changed between two consecutive runs — the `/sync` marker. */
export interface CommandHashMarker {
  /** The first run that ran under the new hash. */
  at: string;
  hash: string | null;
  previous: string | null;
}

export interface CommandResponse {
  command: string;
  installed: boolean;
  /** The catalogue as installed now — the spine the funnel and the stacked bar use. */
  steps: CommandStep[];
  commandHash: string | null;
  /** Every flag any run used, for the facet control. Unfiltered by the current facet. */
  flags: string[];
  /** The facet actually applied. */
  appliedFlags: string[];
  runs: CommandRunListItem[];
  stepReach: StepReach[];
  patterns: PatternFrequency[];
  hashMarkers: CommandHashMarker[];
  /** Per-run work and duration, **oldest first** — `runs` is newest-first for the list. */
  shape: CommandRunShape[];
  meta: {
    totalRuns: number;
    filteredRuns: number;
    /** Runs in `shape` whose duration came off the wider bracket rather than the request span. */
    wallMeasuredRuns: number;
  };
}

/**
 * One command's page: its runs as scatter points, the drop-off funnel and stacked
 * tokens-by-step over them, and how often each pattern fires across them.
 *
 * `flags` narrows which runs are aggregated — the facet answers "is `--sub` cheaper than
 * inline?" without splitting the command into per-flag variants, so the flag list and
 * the hash markers are always computed over *all* of the command's runs. Throws a
 * labelled error the server maps to 404 when neither the catalogue nor the store knows
 * the name.
 */
export async function buildCommand(
  logDir: string,
  commandsDir: string,
  command: string,
  flags: readonly string[] = [],
  source: SidecarSource = fileSource,
): Promise<CommandResponse> {
  const [installed, allRuns] = await Promise.all([listInstalledCommands(commandsDir), source.readCommandRuns(logDir)]);
  const spec = installed.find((c) => c.command === command);
  const own = allRuns
    .filter((r) => r.command === command)
    .sort((a, b) => (a.started ?? '').localeCompare(b.started ?? ''));
  if (!spec && own.length === 0) throw new Error(`command not found: ${command}`);

  // The current catalogue is the stable spine; fall back to the newest run's snapshot so
  // an uninstalled command still renders against the steps it actually ran under.
  const steps = spec?.steps ?? own[own.length - 1]?.steps ?? [];
  const filtered = filterRunsByFlags(own, flags);

  const markers: CommandHashMarker[] = [];
  let previous: string | null | undefined;
  for (const run of own) {
    const hash = run.commandHash ?? null;
    if (previous !== undefined && hash !== previous && run.started) {
      markers.push({ at: run.started, hash, previous });
    }
    previous = hash;
  }

  const shape = commandRunShapes(filtered);

  return {
    command,
    installed: !!spec,
    steps,
    commandHash: spec?.commandHash ?? null,
    flags: [...new Set(own.flatMap((r) => r.flags ?? []))].sort(),
    appliedFlags: [...flags],
    runs: filtered.map(toListItem).reverse(), // newest first for the list; the scatter re-sorts
    stepReach: stepReach(steps, filtered),
    patterns: patternFrequency(filtered),
    hashMarkers: markers,
    shape,
    meta: {
      totalRuns: own.length,
      filteredRuns: filtered.length,
      wallMeasuredRuns: shape.filter((s) => s.wallMeasured).length,
    },
  };
}

function toListItem(run: CommandRun): CommandRunListItem {
  const reached = (run.stepStats ?? []).filter((s) => s.step !== null && s.reached);
  return {
    runId: runKey(run),
    parentRunId: run.parentRunId ?? null,
    parentCommand: run.parentCommand ?? null,
    threadId: run.threadId,
    command: run.command,
    args: run.args ?? '',
    flags: run.flags ?? [],
    prompt: run.prompt ?? '',
    commandHash: run.commandHash ?? null,
    model: run.model ?? null,
    started: run.started ?? null,
    ended: run.ended ?? null,
    outcome: run.outcome ?? 'interrupted',
    interruption: run.interruption ?? null,
    reachedEnd: !!run.reachedEnd,
    totals: runTotals(run),
    patterns: [...new Set((run.patterns ?? []).map((p) => p.id))],
    lastStep: reached[reached.length - 1]?.step ?? null,
    meta: run.meta ?? { turnsUnmapped: 0, nodes: 0, attributed: 0, anchored: 0 },
  };
}

export interface CommandRunResponse {
  run: CommandRun;
  /** How often this run's patterns fire across the rest of the command's runs. */
  patterns: PatternFrequency[];
  /**
   * The existing per-session suggestions covering this run's window, as prose-level
   * diagnosis. Empty once the transcripts behind them have aged out — the run record
   * survives them, and this deliberately does not.
   */
  suggestions: SessionSuggestion[];
  meta: {
    /** Transcripts of this run's family still on disk — the graph can only draw these. */
    transcriptsPresent: number;
    transcripts: number;
    /** True when no captured request survives, so the delta inspector must say so. */
    requestsAgedOut: boolean;
  };
}

/**
 * One run's detail: the full record, its patterns' cross-run frequency, and the
 * suggestions engine's read on the sessions it spans. Throws a labelled error the
 * server maps to 404 when the store has no such run.
 */
export async function buildCommandRun(
  logDir: string,
  runId: string,
  source: SidecarSource = fileSource,
): Promise<CommandRunResponse> {
  const runs = await source.readCommandRuns(logDir);
  // By run id, so a nested run resolves rather than its host answering for it. A
  // top-level run's id *is* its thread id, so old links keep working.
  const run = runs.find((r) => runKey(r) === runId);
  if (!run) throw new Error(`command run not found: ${runId}`);

  const family = new Set(run.threadIds ?? [run.threadId]);
  const sessions = await source.listSessionGraphs(logDir);
  const present = sessions.filter((s) => family.has(s.threadId));
  const buckets = present.length === 0 ? [] : sessionSuggestionBuckets(sessions);

  return {
    run,
    patterns: patternFrequency(runs.filter((r) => r.command === run.command)),
    suggestions: buckets.filter((b) => b.threadIds.some((id) => family.has(id))).flatMap((b) => b.suggestions),
    meta: {
      transcriptsPresent: present.length,
      transcripts: family.size,
      requestsAgedOut: (run.turns ?? []).length === 0,
    },
  };
}

export interface ConceptsResponse {
  /** Newest first — the order the page renders. */
  concepts: StoredConcept[];
  meta: {
    /** The store the list came from, so the page can name its source. */
    storePath: string;
    total: number;
  };
}

/**
 * A concept as it is served, with the meta-skills dropped from both skill lists.
 *
 * The filter lives here rather than in the store reader or the ingester:
 * `logs/concepts.jsonl` keeps every word `/teach` wrote and the table stays a
 * faithful view of it, so only the served answer is trimmed. Both backings pass
 * through this, so shadow mode and the parity harness compare like with like.
 */
function toServedConcept(concept: StoredConcept): StoredConcept {
  const out: StoredConcept = { ...concept, skills: withoutMetaSkills(concept.skills) };
  // Absent stays absent: an empty list would claim the run surfaced nothing,
  // not that it never looked.
  if (concept.surfacedSkills) out.surfacedSkills = withoutMetaSkills(concept.surfacedSkills);
  return out;
}

/**
 * Everything `/teach` has recorded. The store is small and append-only, so the
 * whole list is returned rather than paged.
 */
export async function buildConcepts(logDir: string, source: SidecarSource = fileSource): Promise<ConceptsResponse> {
  const concepts = (await source.readConcepts(logDir)).map(toServedConcept);
  return { concepts, meta: { storePath: conceptStorePath(logDir), total: concepts.length } };
}

export interface ConceptResponse {
  concept: StoredConcept;
  meta: {
    storePath: string;
    /** How many records the store holds. */
    total: number;
  };
}

/**
 * One concept, addressed by the line it sits on. Throws a labelled error the
 * server maps to 404 when the store has no such line.
 */
export async function buildConcept(
  logDir: string,
  ord: number,
  source: SidecarSource = fileSource,
): Promise<ConceptResponse> {
  const concepts = await source.readConcepts(logDir);
  const concept = concepts.find((c) => c.ord === ord);
  if (!concept) throw new Error(`concept not found: ${ord}`);
  return {
    concept: toServedConcept(concept),
    meta: { storePath: conceptStorePath(logDir), total: concepts.length },
  };
}
