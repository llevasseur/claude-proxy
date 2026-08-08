/**
 * Is a branch still running right now?
 *
 * Every other reading in this repo describes what a run already did. None answers the
 * question a dispatcher gets stuck on when a spawn's result never comes back: is that
 * agent dead, or just busy. The two are indistinguishable today, so the safe reading is
 * the pessimistic one — and the cost of reading a live branch as dead is a stalled
 * parent, or a duplicate worktree and a duplicate PR from re-dispatching.
 *
 * The verdict is *derived*, never reported. An agent that crashed cannot self-report, and
 * one whose result the harness ate never got the chance, so nothing here asks the branch
 * anything: it reads the transcript the proxy is already writing. Two facts decide it —
 * when the transcript was last appended to, and whether it carries a terminal turn.
 *
 * Deliberately out of scope: resuming or killing anything. This is a read.
 *
 * Pure: no I/O, and `now` is always passed in, so the same inputs always give the same
 * verdict (which is what lets the file- and DB-backed sources agree — see `parity.ts`).
 */

import type { SessionNode } from './sessions.js';

/**
 * How a branch reads at this instant.
 *
 * - `running` — appended to recently enough, with no terminal turn. Still breathing.
 * - `quiet` — no terminal turn, but nothing appended for {@link QUIET_AFTER_MS}. **Not
 *   dead**: a single long tool call (a full `verify`, an install) appends nothing for
 *   minutes. Quiet is the whole point of the distinction — it says "unknown, lean live"
 *   rather than letting a busy branch read as a dead one.
 * - `finished` — the transcript carries a terminal turn, so there is nothing to wait for.
 * - `unknown` — nothing to judge: no transcript, or none carrying a usable timestamp.
 */
export type LivenessState = 'running' | 'quiet' | 'finished' | 'unknown';

/**
 * How long a branch may go without an append before it reads `quiet` rather than
 * `running`.
 *
 * Ten minutes, because the gap being tolerated is *one tool call*: a branch sitting on
 * `my-command-tools verify` or a cold `pnpm install` makes no request, so it appends
 * nothing for as long as that call runs. Anything much shorter reports every verify step
 * as quiet, which is the pessimistic reading this exists to stop.
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
   * transcript can never say so — its report is the reply to its last request, and no
   * later request in that thread carries that reply — so a subagent that finished
   * perfectly still ends on a tool call. The parent is the only witness.
   */
  reported: boolean;
}

/**
 * Whether a transcript ends on an outcome: a `done:` line, uninterrupted. That line is
 * written from a turn carrying text and no tool call — the agent handing back — so
 * nothing follows it unless the run is asked something new.
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
 * Roll a family of branches up into one verdict — what a dispatcher, or a job holding a
 * whole fan-out, actually wants to know. A family is `running` if any branch is, `quiet`
 * if any is quiet, and only `finished` once every branch has handed back. `terminal` and
 * `lastActivity` describe the family the same way: all of them, and the newest of them.
 *
 * An empty family is `unknown` — no transcript was matched, which is not evidence that
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
