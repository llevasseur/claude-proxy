import { type BranchLiveness, LIVENESS_NOTE, type LivenessState } from '@claude-proxy/core';
import { fmtDuration } from '../format';

/**
 * One branch's liveness verdict, as a badge. `quiet` means "no new step for a while", not
 * "dead" — a branch mid-verify looks exactly like one that crashed, and the tooltip says
 * so rather than guessing.
 */

/** Badge class per state. `running` takes the active tone, `quiet` the caution one. */
const LIVENESS_BADGES = {
  running: 'liveness-running',
  quiet: 'liveness-quiet',
  finished: 'liveness-finished',
  unknown: 'liveness-unknown',
} satisfies Record<LivenessState, string>;

/** The tooltip: the state's own note, plus how stale the transcript is and the threshold. */
export function livenessTitle(liveness: BranchLiveness): string {
  const note = LIVENESS_NOTE[liveness.state];
  if (liveness.idleMs === null) return note;
  const idle = `last step ${fmtDuration(liveness.idleMs)} ago`;
  const threshold = `quiet after ${fmtDuration(liveness.quietAfterMs)}`;
  return `${note} — ${idle}, ${threshold}`;
}

export function LivenessBadge({ liveness }: { liveness: BranchLiveness }) {
  return (
    <span className={`badge ${LIVENESS_BADGES[liveness.state]}`} title={livenessTitle(liveness)}>
      {liveness.state}
    </span>
  );
}
