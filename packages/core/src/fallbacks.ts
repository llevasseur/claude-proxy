/**
 * Every legacy-compatibility branch in the repo, with the day the field that
 * superseded it began being written.
 *
 * A compatibility fallback is speculative generality on a timer. It served a real
 * case the day it was written — a capture that predates some field — and it keeps
 * serving that case only for as long as such a capture is still on disk. `logs/`
 * holds roughly today plus `logs/archive/<date>/`, and that archive rolls, so every
 * one of these branches has a date after which deleting it cannot change behaviour.
 * Nothing in the repo knew that date, which is why three separate feature docs each
 * asked "once those age out, should this go?" and none of them could be answered.
 *
 * This table is the missing half of that question, and on its own it buys nothing —
 * a list of dates is a comment. The other half is
 * `server/test/fallback-retirement.test.ts`, which reads the oldest capture the
 * install *actually retains* and fails for any entry this table dates before that
 * floor, naming the file, the line and the branch to delete. The test never deletes:
 * removing a compatibility branch is a change somebody reviews.
 *
 * ## What belongs here
 *
 * A branch whose reachability the **retention floor decides** — one that reads a
 * captured artifact under `logs/` (an audit sidecar, a session transcript, an
 * archived digest) and copes with that artifact lacking a field. A legacy branch
 * over a store that never rolls (`logs/ideas.jsonl`, settings) does not belong: no
 * amount of archiving ages its old rows out, so the floor says nothing about it.
 *
 * ## Dates are established, never guessed
 *
 * `since` is the day the **writer** started emitting the superseding field — found
 * with `git log -S<field> -- proxy` for a field the proxy writes. Where the history
 * cannot establish one, `since` is `null` and the entry reads as **undated**. That is
 * a supported state, not a gap to paper over with a plausible-looking date: an
 * undated entry is reported on every run rather than passing silently, because a
 * compatibility branch nobody dated is the thing this registry exists to end.
 */

/** One legacy-compatibility branch, dated. */
export interface FallbackEntry {
  /** Stable id, kebab-case. Referenced by the docs page that used to ask about it. */
  id: string;
  /** Repo-relative path of the file holding the branch. */
  file: string;
  /** 1-based line the branch sits on. */
  line: number;
  /**
   * Text {@link line} must contain. The anchor is a line number, and line numbers
   * move; this is what makes the move loud instead of silent, so the registry cannot
   * quietly come to point at unrelated code.
   */
  match: string;
  /**
   * The reporting day (`YYYY-MM-DD`) the superseding field began being written, or
   * `null` when the git history cannot establish one. A capture from before this day
   * is the only thing that still reaches the branch.
   */
  since: string | null;
  /** The commit that started writing the field, for anyone re-deriving `since`. */
  supersededBy: string | null;
  /** What the branch does, and what replaced it. */
  note: string;
}

/**
 * The registry. Ordered by file, then by line, so a diff to it reads as a diff to
 * the code it describes.
 */
export const FALLBACK_REGISTRY: readonly FallbackEntry[] = [
  {
    id: 'digest-legacy-cache-hit-ratio',
    file: 'packages/core/src/digest.ts',
    line: 470,
    match: 'cacheHitRatio:',
    since: null,
    supersededBy: null,
    note:
      'normalizeDigest derives cacheHitRatio from realInput and cacheRead for an archived ' +
      'digest written before the field was stored. Undated: digests are written by the ' +
      'server rather than the proxy and the archive carries a range of schema versions, so ' +
      'no single commit marks the day every persisted digest began carrying the ratio.',
  },
  {
    id: 'session-turn-marker-absent',
    file: 'packages/core/src/sessions.ts',
    line: 277,
    match: 'const TOOL_RE',
    since: '2026-08-06',
    supersededBy: '9e47271',
    note:
      "TOOL_RE's turn marker group is optional. A transcript written before the proxy " +
      'emitted `▸` carries no group 1, so its turn boundaries are unrecoverable and every ' +
      'call reads as its own round trip.',
  },
  {
    id: 'session-subtitle-absent',
    file: 'packages/core/src/sessions.ts',
    line: 396,
    match: 'meta.subtitle ?? meta.firstTask',
    since: '2026-07-24',
    supersededBy: 'd16c76f',
    note:
      'The derived session name falls back to the first task line — the opening prompt raw ' +
      '— for a transcript written before the proxy emitted a `- subtitle:` header.',
  },
  {
    id: 'agent-spawn-tool-allow-list',
    file: 'packages/core/src/sessions.ts',
    line: 661,
    match: "SPAWN_TOOLS = new Set(['Agent', 'Task'])",
    since: '2026-08-07',
    supersededBy: '0bbaec8',
    note:
      'Spawn detection by tool name. The proxy now keys on the call carrying a non-empty ' +
      '`prompt` argument and writes the pairing into the child transcript, so the name ' +
      'allow-list only serves transcripts written before those header lines.',
  },
  {
    id: 'agent-link-start-time-inference',
    file: 'packages/core/src/sessions.ts',
    line: 842,
    match: 'for (const family of families.values())',
    since: '2026-08-07',
    supersededBy: '0bbaec8',
    note:
      "linkAgentSessions' second pass: transcripts sharing a session id are paired to spawn " +
      'lines in start-time order, which a parallel fan-out can get wrong. Every link it ' +
      'makes is flagged `inferred`. Pass one applies the `- parent:` / `- spawn:` / ' +
      '`- agent:` header lines the proxy now writes, so only transcripts predating those ' +
      'lines reach this pass at all.',
  },
  {
    id: 'suggestions-args-hash-key',
    file: 'packages/core/src/suggestions.ts',
    line: 483,
    match: 'node.argsHash ?? node.tool',
    since: '2026-08-07',
    supersededBy: '0bbaec8',
    note:
      "The `redundantReads` rule keys on the proxy's argument fingerprint, falling back to the " +
      'rendered tool line. That line carries one truncated argument, so reads under a long ' +
      'shared path prefix all render alike and the fallback reports duplicates that never ' +
      'happened — which is the defect `argsHash` was added to fix. Only a transcript written ' +
      'before the field still takes it.',
  },
  {
    id: 'skim-block-absent',
    file: 'packages/core/src/skim.ts',
    line: 49,
    match: 'function skimOf',
    since: '2026-07-18',
    supersededBy: '65caf9e',
    note:
      'A sidecar with no `skim` block reads as skim-disabled traffic rather than being ' +
      'skipped. Only a sidecar written before the skim cache existed lacks the block.',
  },
  {
    id: 'audit-sidecar-session-block-optional',
    file: 'packages/core/src/types.ts',
    line: 138,
    match: 'export function isAuditSidecar',
    since: '2026-08-07',
    supersededBy: '0bbaec8',
    note:
      'The structural guard does not require the `session` block, though `sessionId` and ' +
      '`threadId` are what join a transcript to its captured requests. It stays optional ' +
      'because legacy sidecars predate the block; once none are retained the guard can ' +
      'require it and every consumer can stop treating the join key as absent.',
  },
  {
    id: 'request-filename-legacy-colon',
    file: 'server/src/logs.ts',
    line: 237,
    match: 'REQUEST_FILE_RE',
    since: null,
    supersededBy: null,
    note:
      'The captured-request filename guard still admits `:`, which the proxy stopped ' +
      'emitting in favour of `-`. Undated: the separator changed inside moves and ' +
      'refactors rather than in a commit that introduced it, so `git log -S` cannot name ' +
      'the day the last colon-named file was written.',
  },
];

/** What the retention floor says about one entry. */
export type FallbackStatus =
  /** Every retained capture postdates the field. Deleting the branch changes nothing. */
  | 'retirable'
  /** A retained capture still predates the field. The branch is load-bearing. */
  | 'reachable'
  /** No `since` on record, so the floor cannot decide it. */
  | 'undated'
  /** Nothing retained at all, so there is no floor to decide against. */
  | 'unproven';

export interface FallbackVerdict {
  entry: FallbackEntry;
  status: FallbackStatus;
}

/**
 * Judge every entry against `floor` — the oldest reporting day the install still
 * retains, as `server/src/db/source.ts` resolves it, or `null` for an empty corpus.
 *
 * The comparison is **strict**. A field introduced *on* the floor day is not
 * retirable, because a capture from earlier that same day can still be in the
 * floor's directory: reporting days are whole days, and the field started partway
 * through one. Retirement waits until the field predates the oldest retained day
 * outright, which costs at most one extra day of a branch nobody was going to delete
 * that morning anyway.
 */
export function auditFallbacks(
  entries: readonly FallbackEntry[] = FALLBACK_REGISTRY,
  floor: string | null = null,
): FallbackVerdict[] {
  return entries.map((entry) => {
    if (entry.since === null) return { entry, status: 'undated' as const };
    if (floor === null) return { entry, status: 'unproven' as const };
    return { entry, status: entry.since < floor ? ('retirable' as const) : ('reachable' as const) };
  });
}

/** The entries a report should name, one line each: `<id> — <file>:<line>`. */
export function formatFallbackVerdicts(verdicts: readonly FallbackVerdict[]): string {
  return verdicts.map((v) => `  ${v.entry.id} — ${v.entry.file}:${v.entry.line}\n    ${v.entry.note}`).join('\n');
}
