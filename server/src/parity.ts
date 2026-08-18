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
} from './api.js';
import { resolveCommandsDir } from './command-runs.js';
import { remoteConceptStore } from './concepts-remote.js';
import { fileSource, type SidecarSource } from './db/source.js';
import { asError } from './errors.js';
import { resolveSettingsPath } from './settings.js';

/**
 * Shadow mode, and the route registry it shares with the rest of the server.
 * The file-vs-DB equivalence gate this file was named for, and its recorded time
 * and size budgets, are gone.
 *
 * {@link shadowCheck} is a live observer: `SHADOW_DB=1` makes each served
 * response recompute on the *other* backing and logs any disagreement, never
 * disturbing the response that already went out. {@link diffJson} is how it
 * names a disagreement, and {@link PARITY_ROUTES} is the registry of which
 * routes are wired to the substrate and how each one enumerates its cases.
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
