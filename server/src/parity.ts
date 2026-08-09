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
import { fileSource, type SidecarSource } from './db/source.js';
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

/** One replayable request: a label for the failure message, and how to answer it. */
export interface ParityCase {
  label: string;
  run(source: SidecarSource): Promise<unknown>;
}

export interface ParityRoute {
  /** The API path, e.g. `/api/usage`. */
  name: string;
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
  apply(value: unknown): unknown;
}

export const NORMALIZATIONS: Normalization[] = [];

function normalize(value: unknown): unknown {
  return NORMALIZATIONS.reduce<unknown>((acc, n) => n.apply(acc), value);
}

export interface JsonDiff {
  /** Dotted path to the first differing node, e.g. `digest.topTools.3.totalBytes`. */
  path: string;
  files: unknown;
  db: unknown;
}

/**
 * The first structural difference between two JSON values, or `null` when they
 * are identical — including key order, which `JSON.stringify` preserves and the
 * dashboard's byte-for-byte responses depend on.
 */
export function diffJson(a: unknown, b: unknown, at = ''): JsonDiff | null {
  if (Object.is(a, b)) return null;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return { path: at || '$', files: a, db: b };

  if (aIsArr && bIsArr) {
    const arrA = a as unknown[];
    const arrB = b as unknown[];
    if (arrA.length !== arrB.length) return { path: `${at || '$'}.length`, files: arrA.length, db: arrB.length };
    for (let i = 0; i < arrA.length; i += 1) {
      const d = diffJson(arrA[i], arrB[i], at ? `${at}.${i}` : String(i));
      if (d) return d;
    }
    return null;
  }

  const aIsObj = typeof a === 'object' && a !== null;
  const bIsObj = typeof b === 'object' && b !== null;
  if (aIsObj && bIsObj) {
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    // Key order is part of the payload: `JSON.stringify` emits insertion order,
    // and the digest's `models` map inherits it from the read order.
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) {
      return { path: `${at || '$'}{}`, files: keysA, db: keysB };
    }
    for (const k of keysA) {
      const d = diffJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
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
}

/** Serialize the way the server does, so "identical" means identical on the wire. */
function wire(value: unknown): string {
  return JSON.stringify(value);
}

/**
 * Replay one case both ways and compare.
 *
 * The per-process memos are *not* dropped between the two sides: each is keyed
 * by the backing that filled it, so a warm cache cannot hand the DB run the file
 * run's answer, and dropping them would make replaying the whole archive
 * impractical. Call {@link resetCaches} once before a run.
 */
export async function runCase(
  route: ParityRoute,
  testCase: ParityCase,
  fileBacked: SidecarSource,
  dbBacked: SidecarSource,
): Promise<ParityResult> {
  const fromFiles = await testCase.run(fileBacked);
  const fromDb = await testCase.run(dbBacked);

  const a = normalize(fromFiles);
  const b = normalize(fromDb);
  const diff = wire(a) === wire(b) ? null : (diffJson(a, b) ?? { path: '$', files: a, db: b });
  return { route: route.name, label: testCase.label, diff };
}

/** Drop every per-process memo that would otherwise let one backing answer for the other. */
export function resetCaches(): void {
  clearRawArchiveCache();
  clearArchiveCache();
  clearArchivedUsageCache();
  clearLearnedCeilingsCache();
}

/** Archived day directories on disk, oldest first. Empty when nothing is archived. */
export async function archivedDays(logDir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(logDir, 'archive'))).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  } catch {
    return [];
  }
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
    cases: async (ctx) =>
      (await archivedDays(ctx.logDir)).map((day) => ({
        label: `/api/summary?date=${day}`,
        run: (source) => buildSummary(ctx.logDir, day, endOf(day), ctx.archiveDir, source),
      })),
  },
  {
    name: '/api/tools',
    cases: async (ctx) =>
      (await archivedDays(ctx.logDir)).map((day) => ({
        label: `/api/tools?date=${day}`,
        run: (source) => buildTools(ctx.logDir, day, endOf(day), ctx.archiveDir, source),
      })),
  },
  {
    name: '/api/trends',
    cases: async (ctx) => {
      const days = await archivedDays(ctx.logDir);
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
    cases: async (ctx) =>
      (await archivedDays(ctx.logDir)).map((day) => ({
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
    cases: async (ctx) =>
      (await archivedDays(ctx.logDir)).map((day) => ({
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
      return buckets.map((bucket) => ({
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
    cases: async (ctx) =>
      (await archivedDays(ctx.logDir)).map((day) => ({
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
    cases: async (ctx) => {
      const cases: ParityCase[] = [];
      for (const day of await archivedDays(ctx.logDir)) {
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
   * These two checks are about the *local* backings. On a device configured for
   * the hosted store both sides read that instead, so they compare one remote
   * answer with another and say nothing about the file and the table — the
   * request path skips its shadow check for the same reason. Unset
   * `CONCEPTS_URL` to make this pair meaningful again.
   */
  {
    name: '/api/concepts',
    cases: async (ctx) => [{ label: '/api/concepts', run: (source) => buildConcepts(ctx.logDir, source) }],
  },

  /* Enumerated from the store the list route returns, so the `ord` values
   * replayed are exactly the ones the page can link to. */
  {
    name: '/api/concepts/concept',
    cases: async (ctx) => {
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

/** The catalogue a run replays against — pinned on the context, else the installed one. */
function commandsDirOf(ctx: ParityContext): string {
  return ctx.commandsDir ?? resolveCommandsDir();
}

/** The newest transcripts the *files* know about, in the listing's own order. */
async function threadIds(ctx: ParityContext): Promise<string[]> {
  return (await buildSessions(ctx.logDir, fileSource)).sessions.slice(0, PER_THREAD_CASES).map((s) => s.threadId);
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
export function shadowCheck(
  label: string,
  served: unknown,
  compute: () => Promise<unknown>,
  servedKind: SidecarSource['kind'] = 'files',
): void {
  if (!shadowEnabled()) return;
  queueMicrotask(() => {
    void (async () => {
      try {
        const other = normalize(await compute());
        const mine = normalize(served);
        const diff = servedKind === 'db' ? diffJson(other, mine) : diffJson(mine, other);
        if (diff) reportMismatch(label, diff);
      } catch (err) {
        reportError(label, err as Error);
      }
    })();
  });
}
