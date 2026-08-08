/**
 * Is a branch still running right now?
 *
 * The verdict is *derived*, never reported: a crashed agent cannot self-report, and one
 * whose result the harness ate never got the chance, so nothing here asks the branch
 * anything. Two facts decide it — when the transcript was last appended to, and whether
 * it carries a terminal turn.
 *
 * Resuming or killing anything is out of scope; this is a read. Pure, with `now` passed
 * in, so the file- and DB-backed sources agree (`parity.ts`).
 */

import type { SessionNode } from './sessions.js';

/**
 * How a branch reads at this instant.
 *
 * - `running` — appended to recently enough, with no terminal turn. Still breathing.
 * - `quiet` — no terminal turn, but nothing appended for {@link QUIET_AFTER_MS}. **Not
 *   dead**: a single long tool call appends nothing for minutes, so this reads as
 *   "unknown, lean live".
 * - `finished` — the transcript carries a terminal turn, so there is nothing to wait for.
 * - `unknown` — nothing to judge: no transcript, or none carrying a usable timestamp.
 */
export type LivenessState = 'running' | 'quiet' | 'finished' | 'unknown';

/**
 * How long a branch may go without an append before it reads `quiet` rather than
 * `running`. Ten minutes: the gap being tolerated is one long tool call — a full verify,
 * a cold install — which appends nothing for as long as it runs.
 */
export const QUIET_AFTER_MS = 10 * 60_000;

/** What a branch's transcript says about whether it is still going. */
export interface BranchLiveness {
  state: LivenessState;
  /** Newest write observed for this branch, ISO 8601; null when nothing dated it. */
  lastActivity: string | null;
  /** Milliseconds since {@link lastActivity} at the moment of the read; null when undated. */
  idleMs: number | null;
  /** The threshold this verdict was taken against — stated, so a reader can disagree with it. */
  quietAfterMs: number;
  /** True when a terminal turn was found, which is what makes a branch `finished`. */
  terminal: boolean;
}

/** The facts one branch's transcript offers, as the session listings already carry them. */
export interface BranchActivity {
  /** The transcript's mtime, ISO 8601 — it is appended to on every step the branch takes. */
  lastActivity: string | null;
  /** The branch's node stream, for the terminal turn. */
  nodes: readonly SessionNode[];
  /**
   * True when the *parent* recorded this branch's report flowing back. A subagent's own
   * transcript can never say so — a subagent that finished perfectly still ends on a tool
   * call — so the parent is the only witness.
   */
  reported: boolean;
}

/**
 * Whether a transcript ends on an outcome: a `done:` line, uninterrupted. That line comes
 * from a turn carrying text and no tool call, so nothing follows it unless the run is
 * asked something new.
 */
export function endsWithOutcome(nodes: readonly SessionNode[]): boolean {
  const last = nodes[nodes.length - 1];
  return !!last && last.type === 'done' && !last.interrupted;
}

/**
 * Classify one branch against `now`. `finished` beats the clock: a branch that already
 * handed back is not "quiet", however long ago it did so.
 */
export function branchLiveness(
  activity: BranchActivity,
  now: Date | number,
  quietAfterMs: number = QUIET_AFTER_MS,
): BranchLiveness {
  const terminal = activity.reported || endsWithOutcome(activity.nodes);
  const at = Date.parse(activity.lastActivity ?? '');
  // Clock skew between the writer and this read can put an mtime in the future; that is
  // an idle time of zero, not a negative one.
  const idleMs = Number.isNaN(at) ? null : Math.max(0, (typeof now === 'number' ? now : now.getTime()) - at);

  let state: LivenessState;
  if (terminal) state = 'finished';
  else if (idleMs === null) state = 'unknown';
  else state = idleMs > quietAfterMs ? 'quiet' : 'running';

  return { state, lastActivity: activity.lastActivity || null, idleMs, quietAfterMs, terminal };
}

/** Strongest-claim-first: one live branch makes the whole family live. */
const STATE_RANK: Record<LivenessState, number> = { running: 3, quiet: 2, finished: 1, unknown: 0 };

/**
 * Roll a family of branches up into one verdict. `running` if any branch is, `quiet` if
 * any is quiet, and only `finished` once every branch has handed back; `terminal` and
 * `lastActivity` follow the same way — all of them, and the newest of them.
 *
 * An empty family is `unknown` — no transcript matched, which is not evidence that
 * nothing is running.
 */
export function familyLiveness(
  branches: readonly BranchLiveness[],
  quietAfterMs: number = QUIET_AFTER_MS,
): BranchLiveness {
  if (branches.length === 0) {
    return { state: 'unknown', lastActivity: null, idleMs: null, quietAfterMs, terminal: false };
  }

  let state: LivenessState = 'unknown';
  let lastActivity: string | null = null;
  let idleMs: number | null = null;
  let terminal = true;

  for (const branch of branches) {
    if (STATE_RANK[branch.state] > STATE_RANK[state]) state = branch.state;
    if (branch.lastActivity !== null && (lastActivity === null || branch.lastActivity > lastActivity)) {
      lastActivity = branch.lastActivity;
      idleMs = branch.idleMs;
    }
    if (!branch.terminal) terminal = false;
  }

  return { state, lastActivity, idleMs, quietAfterMs, terminal };
}

/** One line saying what a verdict means, for a reader who is deciding whether to re-dispatch. */
export const LIVENESS_NOTE: Record<LivenessState, string> = {
  running: 'appended to just now — still going',
  quiet: 'no new step for a while — busy or stalled, not known to be dead',
  finished: 'handed back — nothing left to wait for',
  unknown: 'no transcript to judge it by',
};
