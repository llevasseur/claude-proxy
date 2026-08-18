import { readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { runKey, type UsageLimitConfig } from '@claude-proxy/core';
import {
  buildCommand,
  buildCommandRun,
  buildCommands,
  buildConcept,
  buildConcepts,
  buildContext,
  buildPromptDetail,
  buildPromptMix,
  buildSession,
  buildSessionBreakdown,
  buildSessionErrors,
  buildSessionGraphNodes,
  buildSessionNodeTexts,
  buildSessionSuggestionBucket,
  buildSessionSuggestions,
  buildSessions,
  buildSessionsGraph,
  buildSessionsLiveness,
  buildSkim,
  buildSkimTrend,
  buildSuggestionStatus,
  buildSummary,
  buildTools,
  buildTrends,
  buildUsage,
  buildWithheld,
  clearRawArchiveCache,
} from './api.js';
import { clearArchiveCache } from './archive.js';
import { resolveCommandsDir } from './command-runs.js';
import { remoteConceptStore } from './concepts-remote.js';
import { fileSource, type SidecarSource } from './db/source.js';
import { asError } from './errors.js';
import { resolveSettingsPath } from './settings.js';
import { clearArchivedUsageCache, clearLearnedCeilingsCache } from './usage-history.js';

/**
 * The parity harness: proof that the SQLite substrate answers a route with the
 * *same bytes* the file scan does.
 *
 * Nothing flips to DB-backed reads until a route is green here for every
 * archived day, and the comparison is of the full JSON — never a row count,
 * never a summary. A diff that cannot be named is a bug in the substrate.
 *
 * Routes register themselves in {@link PARITY_ROUTES}; later slices push onto
 * that array and inherit the apparatus.
 */

export interface ParityContext {
  logDir: string;
  archiveDir?: string;
  limits: UsageLimitConfig;
  /**
   * The archived days a {@link ParityRoute.perDay} route enumerates over. Unset
   * means every day in `logDir/archive`. Scoping lets a suite put each day in
   * its own test; it never narrows what is compared, since each day is still
   * replayed whole.
   */
  days?: string[];
  /**
   * The installed command catalogue (`~/.claude/commands` by default). Pinned on
   * the context rather than resolved per call, so both replays read the same
   * directory even though it sits outside `logs/`.
   */
  commandsDir?: string;
  /**
   * The device settings file `/api/withheld` reads its deny-list from. Pinned for
   * the same reason `commandsDir` is: it is authored state outside `logs/`, and
   * both replays have to see the same bytes.
   */
  settingsPath?: string;
}

/**
 * A value on its way into `JSON.stringify`: what a replayed route answers with,
 * and every node the comparison walks inside one.
 *
 * Deliberately not `JsonValue`. Each `build*` handler answers with its own
 * response *interface*, and an interface carries no index signature, so it does
 * not satisfy `JsonObject` however JSON-shaped its fields are. What this harness
 * actually depends on is narrower than any of those interfaces and is all that is
 * written here: the value serializes, and its keys are read positionally rather
 * than by name.
 */
export type ParityPayload = ParityPayload[] | ParityResponse | boolean | null | number | string | undefined;

/**
 * One route's answer, opaque here: the harness names no field of any response,
 * it only compares two of them key by key. {@link keyedEntries} is the one place
 * that opens one.
 */
// biome-ignore lint/complexity/noBannedTypes: emptiness is the point — an index signature here would be a second copy of each response's contract, and no handler's response interface satisfies one anyway, an interface carrying no implicit index signature.
export type ParityResponse = {};

/** One replayable request: a label for the failure message, and how to answer it. */
export interface ParityCase {
  label: string;
  run(source: SidecarSource): Promise<ParityPayload>;
}

export interface ParityRoute {
  /** The API path, e.g. `/api/usage`. */
  name: string;
  /**
   * Whether this route enumerates one case per archived day, and so honours
   * {@link ParityContext.days}. A route taking no date, or replaying as of the
   * newest day only, leaves it unset.
   */
  perDay?: boolean;
  cases(ctx: ParityContext): Promise<ParityCase[]>;
}

/**
 * A named, justified transform applied to **both** sides before comparison. Each
 * entry has to name the mechanism that makes the difference benign. The list is
 * empty — the DB reader reproduces the file reader's iteration order rather than
 * papering over a different one — and should stay that way.
 */
export interface Normalization {
  name: string;
  why: string;
  apply(value: ParityPayload): ParityPayload;
}

export const NORMALIZATIONS: Normalization[] = [];

function normalize(value: ParityPayload): ParityPayload {
  return NORMALIZATIONS.reduce<ParityPayload>((acc, n) => n.apply(acc), value);
}

export interface JsonDiff {
  /** Dotted path to the first differing node, e.g. `digest.topTools.3.totalBytes`. */
  path: string;
  files: ParityPayload;
  db: ParityPayload;
}

/**
 * The own enumerable entries of a payload object, in insertion order, or
 * `undefined` when the payload is not one.
 *
 * The `Map` keeps the key order `JSON.stringify` emits, which is itself part of
 * what the comparison checks.
 */
function keyedEntries(value: ParityPayload): Map<string, ParityPayload> | undefined {
  if (value === null || value === undefined || Array.isArray(value)) return undefined;
  if (Object(value) !== value || value instanceof Function) return undefined;
  return new Map(Object.entries(value));
}

/**
 * The first structural difference between two JSON values, or `null` when they
 * are identical — including key order, which `JSON.stringify` preserves and the
 * dashboard's byte-for-byte responses depend on.
 */
export function diffJson(a: ParityPayload, b: ParityPayload, at = ''): JsonDiff | null {
  if (Object.is(a, b)) return null;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return { path: at || '$', files: a, db: b };

  if (aIsArr && bIsArr) {
    if (a.length !== b.length) return { path: `${at || '$'}.length`, files: a.length, db: b.length };
    for (let i = 0; i < a.length; i += 1) {
      const d = diffJson(a[i], b[i], at ? `${at}.${i}` : String(i));
      if (d) return d;
    }
    return null;
  }

  const entriesA = keyedEntries(a);
  const entriesB = keyedEntries(b);
  if (entriesA && entriesB) {
    const keysA = [...entriesA.keys()];
    const keysB = [...entriesB.keys()];
    // Key order is part of the payload: `JSON.stringify` emits insertion order,
    // and the digest's `models` map inherits it from the read order.
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      return { path: `${at || '$'}{}`, files: keysA, db: keysB };
    }
    for (const k of keysA) {
      const d = diffJson(entriesA.get(k), entriesB.get(k), at ? `${at}.${k}` : k);
      if (d) return d;
    }
    return null;
  }

  return { path: at || '$', files: a, db: b };
}

export interface ParityResult {
  route: string;
  label: string;
  /** `null` when the two answers were byte-identical. */
  diff: JsonDiff | null;
  /** How long each backing took to answer this case. See {@link CaseTiming}. */
  timing: CaseTiming;
}

/** Serialize the way the server does, so "identical" means identical on the wire. */
function wire(value: ParityPayload): string {
  return JSON.stringify(value);
}

/**
 * Replay one case both ways and compare.
 *
 * The per-process memos are *not* dropped between the two sides: each is keyed
 * by the backing that filled it, so a warm cache cannot hand the DB run the file
 * run's answer, and dropping them would make replaying the whole archive
 * impractical. Call {@link resetCaches} once before a run.
 *
 * Each side is timed while it is replayed, so the time budgets below cost two
 * `performance.now()` reads rather than a second pass over the corpus.
 */
export async function runCase(
  route: ParityRoute,
  testCase: ParityCase,
  fileBacked: SidecarSource,
  dbBacked: SidecarSource,
): Promise<ParityResult> {
  const filesAt = performance.now();
  const fromFiles = await testCase.run(fileBacked);
  const filesMs = performance.now() - filesAt;

  const dbAt = performance.now();
  const fromDb = await testCase.run(dbBacked);
  const dbMs = performance.now() - dbAt;

  const a = normalize(fromFiles);
  const b = normalize(fromDb);
  const served = wire(a);
  const diff = served === wire(b) ? null : (diffJson(a, b) ?? { path: '$', files: a, db: b });
  return {
    route: route.name,
    label: testCase.label,
    diff,
    timing: {
      route: route.name,
      label: testCase.label,
      filesMs,
      dbMs,
      // Sized after both timers have stopped, so weighing the answer never
      // lands in a duration this same case is about to be judged on.
      bytes: Buffer.byteLength(served, 'utf8'),
    },
  };
}

/** Drop every per-process memo that would otherwise let one backing answer for the other. */
export function resetCaches(): void {
  clearRawArchiveCache();
  clearArchiveCache();
  clearArchivedUsageCache();
  clearLearnedCeilingsCache();
}

/** The day directories out of one `archive/` listing, oldest first. */
function dayDirs(names: string[]): string[] {
  return names.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
}

/** Archived day directories on disk, oldest first. Empty when nothing is archived. */
export async function archivedDays(logDir: string): Promise<string[]> {
  try {
    return dayDirs(await readdir(path.join(logDir, 'archive')));
  } catch {
    return [];
  }
}

/**
 * The same listing as {@link archivedDays}, taken synchronously — a suite
 * declaring one test per archived day needs the list while it is being
 * *collected*, which is before any `beforeAll` has run.
 */
export function archivedDaysSync(logDir: string): string[] {
  try {
    return dayDirs(readdirSync(path.join(logDir, 'archive')));
  } catch {
    return [];
  }
}

/** The days a {@link ParityRoute.perDay} route enumerates over: the scoped subset, else all of them. */
async function daysOf(ctx: ParityContext): Promise<string[]> {
  return ctx.days ?? (await archivedDays(ctx.logDir));
}

/**
 * A fixed instant late in `day`, so a window-based route (usage, trends) is
 * evaluated as of that archived day rather than as of now. Both sides get the
 * identical clock.
 */
function endOf(day: string): Date {
  return new Date(`${day}T23:59:00.000Z`);
}

/** The routes wired to the substrate in slice 1. Later slices push onto this array. */
export const PARITY_ROUTES: ParityRoute[] = [
  {
    name: '/api/summary',
    perDay: true,
    cases: async (ctx) =>
      (await daysOf(ctx)).map((day) => ({
        label: `/api/summary?date=${day}`,
        run: (source) => buildSummary(ctx.logDir, day, endOf(day), ctx.archiveDir, source),
      })),
  },
  {
    name: '/api/tools',
    perDay: true,
    cases: async (ctx) =>
      (await daysOf(ctx)).map((day) => ({
        label: `/api/tools?date=${day}`,
        run: (source) => buildTools(ctx.logDir, day, endOf(day), ctx.archiveDir, source),
      })),
  },
  {
    name: '/api/trends',
    perDay: true,
    cases: async (ctx) => {
      const days = await daysOf(ctx);
      const cases: ParityCase[] = [];
      for (const day of days) {
        for (const window of [7, 30]) {
          cases.push({
            label: `/api/trends?days=${window} as of ${day}`,
            run: (source) => buildTrends(ctx.logDir, window, endOf(day), ctx.archiveDir, source),
          });
        }
      }
      return cases;
    },
  },
  {
    name: '/api/prompt-mix',
    perDay: true,
    cases: async (ctx) =>
      (await daysOf(ctx)).map((day) => ({
        label: `/api/prompt-mix?days=7 as of ${day}`,
        run: (source) => buildPromptMix(ctx.logDir, 7, endOf(day), source),
      })),
  },
  /* Hashes come from the file side's own mix, so the ones replayed are exactly
   * the ones the cohort table can link to. Identified cohorts only, and only a
   * day's biggest few: every case rescans the whole window on both sources, and
   * a busy day carries hundreds of distinct prompts. */
  {
    name: '/api/prompt',
    cases: async (ctx) => {
      const last = (await archivedDays(ctx.logDir)).at(-1);
      if (!last) return [];
      const { days } = await buildPromptMix(ctx.logDir, 7, endOf(last), fileSource);
      const hashes = new Set(
        days.flatMap((d) => d.cohorts.flatMap((c) => (c.hash ? [c.hash] : [])).slice(0, PROMPTS_PER_DAY)),
      );
      return [...hashes].map((hash) => ({
        label: `/api/prompt?hash=${hash}&days=7 as of ${last}`,
        run: (source: SidecarSource) => buildPromptDetail(ctx.logDir, hash, 7, endOf(last), source),
      }));
    },
  },
  {
    name: '/api/usage',
    perDay: true,
    cases: async (ctx) =>
      (await daysOf(ctx)).map((day) => ({
        label: `/api/usage as of ${day}`,
        run: (source) => buildUsage(ctx.logDir, ctx.limits, endOf(day), source),
      })),
  },

  /* --- Slice 2: session transcripts --- *
   *
   * Enumerated from the *file* side, so the DB side is never asked only about
   * threads it happens to know: a transcript the substrate missed shows up as a
   * `session not found` throw against a case the files answered.
   *
   * `/api/sessions/session` is the deliberate exception: it has a per-read
   * fallback, so a transcript with no row reads off the file rather than
   * 404-ing. A missed transcript still shows up in `/api/sessions`, which
   * replays whole and turns a missing row into a length difference.
   *
   * `/api/context/detail`, `/api/context/message` and `/api/context/tool` are
   * absent: they read a `.request.txt` body off disk and touch no indexed
   * column, so there is no DB path to disagree on.
   */
  {
    name: '/api/sessions',
    cases: async (ctx) => [{ label: '/api/sessions', run: (source) => buildSessions(ctx.logDir, source) }],
  },
  {
    name: '/api/sessions/graph',
    // One `now` across both backings — the payload carries a liveness verdict taken
    // against the clock, so two reads a moment apart would diff on the clock alone.
    cases: async (ctx) => {
      const now = new Date();
      return [{ label: '/api/sessions/graph', run: (source) => buildSessionsGraph(ctx.logDir, now, source) }];
    },
  },
  {
    name: '/api/sessions/liveness',
    cases: async (ctx) => {
      const now = new Date();
      return [{ label: '/api/sessions/liveness', run: (source) => buildSessionsLiveness(ctx.logDir, now, source) }];
    },
  },
  {
    name: '/api/sessions/session',
    cases: async (ctx) =>
      (await threadIds(ctx)).map((id) => ({
        label: `/api/sessions/session?id=${id}`,
        run: (source) => buildSession(ctx.logDir, id, source),
      })),
  },
  {
    name: '/api/sessions/node-text',
    cases: async (ctx) =>
      (await threadIds(ctx)).map((id) => ({
        label: `/api/sessions/node-text?id=${id}`,
        run: (source) => buildSessionNodeTexts(ctx.logDir, id, source),
      })),
  },
  {
    name: '/api/sessions/breakdown',
    cases: async (ctx) => {
      // One clock for every case and both sides, so the live/archive split a
      // request falls on cannot move between the two replays.
      const now = new Date();
      return (await threadIds(ctx)).map((id) => ({
        label: `/api/sessions/breakdown?id=${id}`,
        run: (source) => buildSessionBreakdown(ctx.logDir, id, now, source),
      }));
    },
  },
  {
    name: '/api/sessions/errors',
    cases: async (ctx) => {
      const now = new Date();
      return (await threadIds(ctx)).map((id) => ({
        label: `/api/sessions/errors?id=${id}`,
        run: (source) => buildSessionErrors(ctx.logDir, id, now, source),
      }));
    },
  },
  {
    name: '/api/sessions/graph/nodes',
    cases: async (ctx) => {
      const now = new Date();
      return (await threadIds(ctx)).map((id) => ({
        label: `/api/sessions/graph/nodes?id=${id}`,
        run: (source) => buildSessionGraphNodes(ctx.logDir, id, now, source),
      }));
    },
  },
  {
    name: '/api/sessions/suggestions',
    cases: async (ctx) => [
      { label: '/api/sessions/suggestions', run: (source) => buildSessionSuggestions(ctx.logDir, source) },
    ],
  },
  {
    name: '/api/sessions/suggestions/bucket',
    cases: async (ctx) => {
      const now = new Date();
      // Bucket numbering is derived from the transcripts, so the indices to
      // replay come from the file side's own answer.
      const { buckets } = await buildSessionSuggestions(ctx.logDir, fileSource);
      return buckets.slice(0, BUCKETS_PER_RUN).map((bucket) => ({
        label: `/api/sessions/suggestions/bucket?index=${bucket.index}`,
        run: (source) => buildSessionSuggestionBucket(ctx.logDir, bucket.index, now, source),
      }));
    },
  },

  /* --- Slice 3: command runs --- *
   *
   * Enumerated from the file side, like slice 2's routes: the DB is asked about
   * every command and run the store knows, not only the ones it managed to
   * index. A run the substrate missed surfaces as a `command run not found`
   * throw against a case the files answered.
   *
   * The `/stream` variants are absent: SSE re-serves the same builder on a
   * watch, so the payload under test is the non-streaming one.
   */
  {
    name: '/api/commands',
    cases: async (ctx) => [
      { label: '/api/commands', run: (source) => buildCommands(ctx.logDir, commandsDirOf(ctx), source) },
    ],
  },
  {
    name: '/api/commands/command',
    cases: async (ctx) => {
      const commandsDir = commandsDirOf(ctx);
      const { commands } = await buildCommands(ctx.logDir, commandsDir, fileSource);
      const cases: ParityCase[] = [];
      for (const summary of commands) {
        cases.push({
          label: `/api/commands/command?name=${summary.command}`,
          run: (source) => buildCommand(ctx.logDir, commandsDir, summary.command, [], source),
        });
        // One facet per command, so the flag filter is exercised rather than
        // only the unfiltered aggregate.
        const facet = summary.flags[0];
        if (facet) {
          cases.push({
            label: `/api/commands/command?name=${summary.command}&flags=${facet}`,
            run: (source) => buildCommand(ctx.logDir, commandsDir, summary.command, [facet], source),
          });
        }
      }
      return cases;
    },
  },
  {
    name: '/api/commands/run',
    cases: async (ctx) => {
      const runs = await fileSource.readCommandRuns(ctx.logDir);
      return runs.slice(0, PER_THREAD_CASES).map((run) => ({
        // By run id, the same key the route takes: a nested run's id is not its
        // thread id, and asking by thread would replay its host instead.
        label: `/api/commands/run?id=${runKey(run)}`,
        run: (source) => buildCommandRun(ctx.logDir, runKey(run), source),
      }));
    },
  },

  /* --- Slice 4: the remainder --- *
   *
   * The read paths still scanning after slice 3. None needed a new table: each
   * is a different aggregation over the sidecars and session graphs slices 1 and
   * 2 already index.
   *
   * `/api/projects`, `/api/jobs`, `/api/hooks-plugins` and `/api/system-prompt`
   * are deliberately absent: they read `~/.claude/projects`, `~/.claude/jobs`,
   * `~/.claude/settings.json` and `~/.claude/CLAUDE.md`, all outside the `logs/`
   * scope ADR 0004 gives the substrate and none re-derivable by re-ingesting. Indexing one would put the
   * only copy of something in a disposable view — the same boundary that kept
   * `~/.claude/commands` out in slice 3. `/api/filters` reads no disk.
   *
   * `/api/skim` replays as of *every* archived day; the two window-shaped routes
   * below only as of the newest. A window aggregates the same per-day reads, so
   * replaying each window as of each day re-reads the corpus quadratically for
   * coverage that is already there.
   */
  {
    name: '/api/skim',
    perDay: true,
    cases: async (ctx) =>
      (await daysOf(ctx)).map((day) => ({
        label: `/api/skim?date=${day}`,
        run: (source) => buildSkim(ctx.logDir, day, endOf(day), ctx.archiveDir, source),
      })),
  },
  {
    name: '/api/skim/trend',
    cases: async (ctx) => {
      const last = (await archivedDays(ctx.logDir)).at(-1);
      if (!last) return [];
      return [7, 30].map((window) => ({
        label: `/api/skim/trend?days=${window} as of ${last}`,
        run: (source) => buildSkimTrend(ctx.logDir, window, endOf(last), source),
      }));
    },
  },
  {
    name: '/api/withheld',
    cases: async (ctx) => {
      const settingsPath = ctx.settingsPath ?? resolveSettingsPath();
      const last = (await archivedDays(ctx.logDir)).at(-1);
      if (!last) return [];
      return [7, 30].map((window) => ({
        label: `/api/withheld?days=${window} as of ${last}`,
        run: (source) => buildWithheld(ctx.logDir, window, settingsPath, endOf(last), source),
      }));
    },
  },
  {
    // Only the derived half has a DB path: the bucket/suggestion join comes from
    // the indexed session graphs, while the flags stay a file on both sides.
    name: '/api/sessions/suggestions/status',
    cases: async (ctx) => {
      const { buckets } = await buildSessionSuggestions(ctx.logDir, fileSource);
      const cases: ParityCase[] = [
        {
          label: '/api/sessions/suggestions/status',
          run: (source) => buildSuggestionStatus(ctx.logDir, {}, source),
        },
        {
          label: '/api/sessions/suggestions/status?detail=1',
          run: (source) => buildSuggestionStatus(ctx.logDir, { detail: true }, source),
        },
      ];
      const first = buckets[0];
      if (first) {
        cases.push({
          label: `/api/sessions/suggestions/status?range=${first.index}`,
          run: (source) => buildSuggestionStatus(ctx.logDir, { buckets: [first.index], detail: true }, source),
        });
      }
      return cases;
    },
  },
  {
    name: '/api/context',
    perDay: true,
    cases: async (ctx) => {
      const cases: ParityCase[] = [];
      for (const day of await daysOf(ctx)) {
        for (const window of [7, 30]) {
          cases.push({
            label: `/api/context?days=${window} as of ${day}`,
            run: (source) => buildContext(ctx.logDir, window, endOf(day), source),
          });
        }
      }
      return cases;
    },
  },

  /* --- Concepts --- *
   *
   * `logs/concepts.jsonl` is inside the substrate's scope, so unlike
   * `/api/system-prompt` this one belongs here. One case: the store is a single
   * file with no key and no filter, so there is nothing to enumerate over.
   *
   * Both checks are about the *local* backings, so both enumerate nothing when
   * the hosted store is configured — there the two sides would be one remote
   * answer compared with another, at a full-corpus fetch per case per side.
   */
  {
    name: '/api/concepts',
    cases: async (ctx) =>
      remoteConceptStore() ? [] : [{ label: '/api/concepts', run: (source) => buildConcepts(ctx.logDir, source) }],
  },

  /* Enumerated from the store the list route returns, so the `ord` values
   * replayed are exactly the ones the page can link to. */
  {
    name: '/api/concepts/concept',
    cases: async (ctx) => {
      if (remoteConceptStore()) return [];
      const { concepts } = await buildConcepts(ctx.logDir);
      return concepts.map((concept) => ({
        label: `/api/concepts/concept?ord=${concept.ord}`,
        run: (source) => buildConcept(ctx.logDir, concept.ord, source),
      }));
    },
  },
];

/**
 * How many transcripts the per-thread routes replay, newest first.
 *
 * Coverage is not lost: `/api/sessions` and `/api/sessions/graph` are replayed
 * whole and carry every transcript's metadata and node stream. The cap bounds
 * only the routes that re-read request bodies per thread.
 */
const PER_THREAD_CASES = 20;

/**
 * Prompt hashes replayed per archived day, biggest contribution first.
 *
 * Uncapped this is one case per distinct prompt, and each rescans the window on
 * both sources — a few hundred prompts in a day is enough to take the whole run
 * past its timeout. The biggest cohorts are the ones the mix page links to.
 */
const PROMPTS_PER_DAY = 3;

/**
 * How many suggestion buckets the drill-down route replays, newest first.
 *
 * Buckets accrue every fifty sessions and never retire, so uncapped this route's
 * cost climbs for as long as the machine is used. Coverage is not lost:
 * `/api/sessions/suggestions` replays whole and carries every bucket with its
 * suggestions, so the cap bounds only the per-bucket drill-down.
 */
const BUCKETS_PER_RUN = 20;

/** The catalogue a run replays against — pinned on the context, else the installed one. */
function commandsDirOf(ctx: ParityContext): string {
  return ctx.commandsDir ?? resolveCommandsDir();
}

/** The newest transcripts the *files* know about, in the listing's own order. */
async function threadIds(ctx: ParityContext): Promise<string[]> {
  return (await buildSessions(ctx.logDir, fileSource)).sessions.slice(0, PER_THREAD_CASES).map((s) => s.threadId);
}

/* ------------------------------------------------------------------ *
 * Time budgets
 * ------------------------------------------------------------------ */

/**
 * The other half of the harness. Everything above proves the two backings agree
 * on the *bytes*; none of it says a word about the *time*, and a route that got
 * seven times slower stayed byte-identical the whole way down.
 *
 * That is not hypothetical. `CHANGELOG.md` records `/api/usage` at 3.13s over a
 * 713 MB database holding 18 archived days; over a 1.43 GB database holding 24,
 * the same route measures 26.6s. No gate reported it, because those numbers were
 * taken by hand once and never became an assertion. Numbers in prose rot; this
 * turns them into a recorded fixture that a replay compares itself against.
 *
 * What is asserted is a **regression against a recorded baseline on this
 * harness's own replay**, not a service-level target for the HTTP route. The two
 * are different quantities — the replay reads a frozen snapshot with the OS page
 * cache in whatever state the previous case left it — and only the first is
 * something a test can hold still enough to gate on.
 */

/** How long one replayed case took through each backing, and how large its answer was. */
export interface CaseTiming {
  route: string;
  label: string;
  filesMs: number;
  dbMs: number;
  /**
   * The serialized answer's size in bytes.
   *
   * One number rather than one per backing, because the assertion this harness
   * exists for is that the two backings serialize to the *same* string — a case
   * where they disagree is already a parity failure, and how big each side's
   * disagreement was is not the interesting fact about it.
   *
   * Measured with {@link Buffer.byteLength} rather than `String.length`, over
   * the string the byte comparison already built. `String.length` counts UTF-16
   * code units, and this corpus is transcript text: a route whose answer is
   * mostly prose would be recorded at a size it never puts on the wire, in a
   * field a reader will read as megabytes. Nothing is serialized twice for it.
   */
  bytes: number;
}

/** Which reader a duration belongs to. Both are budgeted; see {@link RouteBudget}. */
export type Backing = 'files' | 'db';

/**
 * One route's recorded per-case medians, in milliseconds.
 *
 * Both backings are budgeted rather than only the substrate, because the
 * regression that prompted this is *comparative*: the substrate is slower than
 * the file scan it replaced on `/api/summary` and `/api/trends`, which is a fact
 * only visible when both sides are on record. The fixture states the two
 * numbers; it deliberately does **not** assert `db < files`, since that assertion
 * fails today for reasons this harness is not the place to fix.
 */
export interface RouteBudget {
  files: number;
  db: number;
  /**
   * The largest answer the route serialized, in bytes.
   *
   * A duration is not the only way a route regresses, and it is not the way
   * that hides best: `/api/sessions/graph` built in 152.9 ms and sat well
   * inside its time budget while handing back 28.2 MB, because a payload that
   * is merely enormous is still fast to assemble. One number per route rather
   * than one per backing, for the reason {@link CaseTiming.bytes} gives.
   */
  bytes: number;
}

/** The recorded fixture: what was measured, against what, and with how much slack. */
export interface RouteBudgets {
  /** When the numbers below were taken, so a stale fixture is legible as stale. */
  recordedAt: string;
  /** The corpus they were taken against — the archive only grows, so this moves. */
  corpus: { archivedDays: number; note: string };
  /**
   * What a median may be multiplied by before it counts as a breach.
   *
   * Three. It is picked against the recorded spread rather than by taste: the
   * changelog's own consecutive passes over one unchanged corpus vary by up to
   * 29% (`/api/summary` 1.52s then 1.18s) and 20% (`/api/usage` 3.13s then
   * 3.77s), so a machine under load plausibly doubles a number without anything
   * having regressed. The failure this exists to catch is sevenfold. Three sits
   * clear of the noise and well under the signal.
   */
  headroom: number;
  /**
   * The smallest allowance any route gets, in milliseconds, regardless of what
   * it measured.
   *
   * Headroom is proportional and the noise it is calibrated against is not. Two
   * routes in the recorded fixture answer in **0.1 ms** — they read one already
   * loaded object — and ×3 on that is an allowance of 0.3 ms, which a single
   * timer quantum or a scheduler hiccup crosses while nothing whatsoever has
   * regressed. Below the floor, absolute jitter dominates and the ratio stops
   * meaning anything; above it, the floor never binds, because ×3 of anything
   * over ~17 ms is already larger. Fifty milliseconds sits above scheduling
   * noise and below any duration a human would call slow.
   */
  floorMs: number;
  /**
   * The smallest size allowance any route gets, in bytes, regardless of what it
   * measured.
   *
   * The same argument {@link RouteBudgets.floorMs} makes, in the other unit —
   * proportional headroom over a tiny recorded number is a tiny allowance. A
   * route answering `{"ok":true}` records 11 bytes, and ×3 on that is 33: one
   * added field breaches it while nothing has grown in any sense a reader would
   * recognise. 64 KiB is chosen the way 50 ms was, by what the quantity means
   * rather than by taste — comfortably above every route here that returns a
   * single object, and far below any response size worth a build failure. It
   * does not bind on anything large, since ×3 of anything over ~21 KiB already
   * exceeds it.
   *
   * A separate constant from `floorMs` because the two are not convertible:
   * milliseconds and bytes share the headroom multiplier, which is a ratio, and
   * nothing else.
   */
  floorBytes: number;
  /**
   * Per-route medians. A route absent from this map is *unbudgeted*, which is
   * reported and never failed: a newly registered route has nothing recorded yet,
   * and failing the build for that would make adding a route to
   * {@link PARITY_ROUTES} require a measurement pass first.
   */
  routes: Record<string, RouteBudget>;
}

/** One route/backing pair judged against its budget. */
export interface BudgetCheck {
  route: string;
  backing: Backing;
  cases: number;
  medianMs: number;
  budgetMs: number;
  allowedMs: number;
  over: boolean;
}

/** One route's largest answer judged against its size budget. */
export interface SizeCheck {
  route: string;
  cases: number;
  bytes: number;
  budgetBytes: number;
  allowedBytes: number;
  over: boolean;
}

export interface BudgetReport {
  checks: BudgetCheck[];
  /** One entry per budgeted route replayed, judging size rather than duration. */
  sizes: SizeCheck[];
  /** Human-readable breach lines, empty when every budgeted route was inside its allowance. */
  breaches: string[];
  /** Routes that were replayed but carry no recorded budget. Reported, never failed. */
  unbudgeted: string[];
}

/**
 * The middle value of a set of durations.
 *
 * Median rather than mean or max, because one case in a replay of several
 * hundred reliably catches a GC pause — and a mean carries that outlier into the
 * number while a max *is* the outlier. A route that genuinely regressed moves
 * every case, which moves the median.
 */
export function medianMs(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The largest value in a set of serialized sizes.
 *
 * Max rather than the median {@link medianMs} takes, because the two quantities
 * are not alike. A duration carries measurement noise the median exists to
 * reject — one case in a replay of several hundred reliably catches a GC pause.
 * A serialized length carries none: the same corpus through the same code
 * produces the same string every time, so there is no outlier to discard and
 * every case is signal. And the case worth gating on is the *biggest* answer a
 * route ever hands back, which a median over many small days would hide.
 */
export function maxBytes(values: number[]): number {
  return values.reduce((hi, v) => (v > hi ? v : hi), 0);
}

/** A size in the unit a human would state it in, so a breach line reads at a glance. */
function statedBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

/** Per-route durations split by backing, and per-route sizes, in replay order. */
function byRoute(timings: CaseTiming[]): Map<string, { files: number[]; db: number[]; bytes: number[] }> {
  const out = new Map<string, { files: number[]; db: number[]; bytes: number[] }>();
  for (const t of timings) {
    const entry = out.get(t.route) ?? { files: [], db: [], bytes: [] };
    entry.files.push(t.filesMs);
    entry.db.push(t.dbMs);
    entry.bytes.push(t.bytes);
    out.set(t.route, entry);
  }
  return out;
}

/** Judge a replay's timings and response sizes against the recorded fixture. */
export function checkBudgets(timings: CaseTiming[], budgets: RouteBudgets): BudgetReport {
  const checks: BudgetCheck[] = [];
  const sizes: SizeCheck[] = [];
  const breaches: string[] = [];
  const unbudgeted: string[] = [];

  for (const [route, durations] of byRoute(timings)) {
    const budget = budgets.routes[route];
    if (!budget) {
      unbudgeted.push(route);
      continue;
    }
    for (const backing of ['files', 'db'] as const) {
      const observed = medianMs(durations[backing]);
      const budgetMs = budget[backing];
      const allowedMs = Math.max(budgetMs * budgets.headroom, budgets.floorMs);
      const over = observed > allowedMs;
      checks.push({
        route,
        backing,
        cases: durations[backing].length,
        medianMs: observed,
        budgetMs,
        allowedMs,
        over,
      });
      if (over) {
        breaches.push(
          `${route} (${backing}) median ${observed.toFixed(0)}ms over ${durations[backing].length} cases ` +
            `exceeds its allowance of ${allowedMs.toFixed(0)}ms ` +
            `(recorded ${budgetMs.toFixed(0)}ms ×${budgets.headroom}, floor ${budgets.floorMs}ms)`,
        );
      }
    }

    // Size is judged once per route rather than once per backing: the two
    // backings agreed on the bytes, or the parity assertion already failed.
    const observedBytes = maxBytes(durations.bytes);
    const allowedBytes = Math.max(budget.bytes * budgets.headroom, budgets.floorBytes);
    const overBytes = observedBytes > allowedBytes;
    sizes.push({
      route,
      cases: durations.bytes.length,
      bytes: observedBytes,
      budgetBytes: budget.bytes,
      allowedBytes,
      over: overBytes,
    });
    if (overBytes) {
      breaches.push(
        `${route} (size) largest answer ${statedBytes(observedBytes)} over ${durations.bytes.length} cases ` +
          `exceeds its allowance of ${statedBytes(allowedBytes)} ` +
          `(recorded ${statedBytes(budget.bytes)} ×${budgets.headroom}, floor ${statedBytes(budgets.floorBytes)})`,
      );
    }
  }
  return { checks, sizes, breaches: breaches.sort(), unbudgeted: unbudgeted.sort() };
}

/**
 * Budgeted route names that no longer name a registered route.
 *
 * A rename would otherwise silently un-budget a route: the old key stops
 * matching, the new name reads as merely unbudgeted, and the gate goes quiet on
 * exactly the route someone was just editing.
 */
export function unknownBudgetRoutes(budgets: RouteBudgets): string[] {
  const known = new Set(PARITY_ROUTES.map((r) => r.name));
  return Object.keys(budgets.routes)
    .filter((name) => !known.has(name))
    .sort();
}

/**
 * Whether the budget gate runs at all.
 *
 * On by default wherever there is a real archive to replay, which is this
 * device and not CI — a clean clone has no `logs/archive`, so the suite that
 * carries these timings already enumerates nothing there and the gate has
 * nothing to judge. `ROUTE_BUDGETS=0` turns it off for a run on a machine known
 * to be busy — an escape hatch rather than an opt-in flag nobody remembers to
 * set on the one machine that can catch the regression.
 */
export function budgetsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ROUTE_BUDGETS;
  return v !== '0' && v !== 'false';
}

/** Whether this run rewrites the fixture instead of judging against it. */
export function budgetsRecording(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ROUTE_BUDGETS === 'record';
}

/** Build the fixture a `ROUTE_BUDGETS=record` run writes out. */
export function recordBudgets(
  timings: CaseTiming[],
  previous: RouteBudgets,
  archivedDays: number,
  at: Date,
): RouteBudgets {
  const routes: Record<string, RouteBudget> = {};
  for (const [route, durations] of [...byRoute(timings)].sort(([a], [b]) => a.localeCompare(b))) {
    routes[route] = {
      files: Number(medianMs(durations.files).toFixed(1)),
      db: Number(medianMs(durations.db).toFixed(1)),
      bytes: maxBytes(durations.bytes),
    };
  }
  return {
    recordedAt: at.toISOString(),
    corpus: { archivedDays, note: previous.corpus.note },
    headroom: previous.headroom,
    floorMs: previous.floorMs,
    floorBytes: previous.floorBytes,
    routes,
  };
}

/* ------------------------------------------------------------------ *
 * Shadow mode
 * ------------------------------------------------------------------ */

/**
 * Shadow mode: serve the answer, compute the *other* backing's answer alongside,
 * and log any disagreement. Off unless `SHADOW_DB` is set, and strictly an
 * observer — the response is already written when the comparison starts, and
 * every failure inside it is swallowed.
 *
 * The shadow is the file scan by default and the substrate under `DB_READS=0` —
 * always the opinion the response did *not* come from.
 */
export function shadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SHADOW_DB;
  return v === '1' || v === 'true';
}

export interface ShadowHooks {
  onMismatch?(label: string, diff: JsonDiff): void;
  onError?(label: string, err: Error): void;
}

let hooks: ShadowHooks = {};

/** Redirect shadow reporting (tests, or a future mismatch log). */
export function setShadowHooks(next: ShadowHooks): void {
  hooks = next;
}

function reportMismatch(label: string, diff: JsonDiff): void {
  if (hooks.onMismatch) {
    hooks.onMismatch(label, diff);
    return;
  }
  console.warn(
    `[shadow] ${label} differs at ${diff.path}: files=${JSON.stringify(diff.files)} db=${JSON.stringify(diff.db)}`,
  );
}

function reportError(label: string, err: Error): void {
  if (hooks.onError) {
    hooks.onError(label, err);
    return;
  }
  console.warn(`[shadow] ${label} could not be checked: ${err.message}`);
}

/**
 * Compare an already-served response against what the other backing would have
 * said. Returns immediately; the check runs on a later tick and never rejects.
 *
 * `servedKind` says which backing produced `served`, so a reported diff names
 * the file answer `files` and the substrate's `db` whichever side served.
 */
export function shadowCheck<Served, Shadowed>(
  label: string,
  served: Served,
  compute: () => Promise<Shadowed>,
  servedKind: SidecarSource['kind'] = 'files',
): void {
  if (!shadowEnabled()) return;
  queueMicrotask(() => {
    void (async () => {
      try {
        // SAFETY: shadow mode is only ever handed route payloads — `served` is
        // the object the response was serialized from, and `compute` rebuilds
        // that same route on the other backing — so both sit inside
        // `ParityPayload`. They are two independent type parameters because a
        // disagreement is exactly what this looks for: the two answers are
        // compared, never assumed to be the same shape.
        const other = normalize((await compute()) as ParityPayload);
        // SAFETY: the same argument for the side that was already served.
        const mine = normalize(served as ParityPayload);
        const diff = servedKind === 'db' ? diffJson(other, mine) : diffJson(mine, other);
        if (diff) reportMismatch(label, diff);
      } catch (cause) {
        reportError(label, asError(cause));
      }
    })();
  });
}
