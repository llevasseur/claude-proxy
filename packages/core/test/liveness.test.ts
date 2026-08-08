import { describe, expect, it } from 'vitest';
import {
  type BranchActivity,
  branchLiveness,
  endsWithOutcome,
  familyLiveness,
  LIVENESS_NOTE,
  QUIET_AFTER_MS,
} from '../src/liveness.js';
import type { SessionNode, SessionNodeType } from '../src/sessions.js';

/** A node fixture — only `type` and `interrupted` matter to the verdict. */
const node = (type: SessionNodeType, interrupted = false): SessionNode => ({
  index: 0,
  type,
  text: 'whatever',
  tool: null,
  task: null,
  interruption: null,
  interrupted,
  message: null,
  turn: null,
});

const NOW = Date.parse('2026-08-07T12:00:00.000Z');
/** An ISO stamp `ms` before `NOW`. */
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const activity = (over: Partial<BranchActivity> = {}): BranchActivity => ({
  lastActivity: ago(60_000),
  nodes: [node('tool')],
  reported: false,
  ...over,
});

describe('endsWithOutcome', () => {
  it('is true only for a transcript ending on an uninterrupted done', () => {
    expect(endsWithOutcome([node('tool'), node('done')])).toBe(true);
    expect(endsWithOutcome([node('done'), node('tool')])).toBe(false);
    expect(endsWithOutcome([])).toBe(false);
  });

  it('does not count a done the run was cut off at', () => {
    expect(endsWithOutcome([node('done', true)])).toBe(false);
  });
});

describe('branchLiveness', () => {
  it('reads a recently appended branch as running', () => {
    const live = branchLiveness(activity(), NOW);
    expect(live.state).toBe('running');
    expect(live.idleMs).toBe(60_000);
    expect(live.terminal).toBe(false);
  });

  it('goes quiet past the threshold, without claiming the branch is dead', () => {
    expect(branchLiveness(activity({ lastActivity: ago(QUIET_AFTER_MS + 1) }), NOW).state).toBe('quiet');
    // The boundary itself is still running — the threshold is what it takes to *exceed*.
    expect(branchLiveness(activity({ lastActivity: ago(QUIET_AFTER_MS) }), NOW).state).toBe('running');
    expect(LIVENESS_NOTE.quiet).toMatch(/not known to be dead/);
  });

  it('honours a caller-supplied threshold and reports it back', () => {
    const live = branchLiveness(activity({ lastActivity: ago(90_000) }), NOW, 60_000);
    expect(live.state).toBe('quiet');
    expect(live.quietAfterMs).toBe(60_000);
  });

  it('is finished once the transcript hands back, however long ago that was', () => {
    const done = activity({ lastActivity: ago(9 * 60 * 60_000), nodes: [node('tool'), node('done')] });
    const live = branchLiveness(done, NOW);
    expect(live.state).toBe('finished');
    expect(live.terminal).toBe(true);
  });

  it("is finished when the parent recorded a report the subagent's own transcript cannot show", () => {
    // A subagent ends on its last tool call even when it finished perfectly.
    const live = branchLiveness(activity({ nodes: [node('tool')], reported: true }), NOW);
    expect(live.state).toBe('finished');
  });

  it('is unknown when nothing dates the branch', () => {
    const live = branchLiveness(activity({ lastActivity: null }), NOW);
    expect(live.state).toBe('unknown');
    expect(live.idleMs).toBeNull();
    expect(branchLiveness(activity({ lastActivity: 'not a date' }), NOW).state).toBe('unknown');
  });

  it('accepts a Date as well as an epoch, and floors clock skew at zero idle', () => {
    expect(branchLiveness(activity(), new Date(NOW)).idleMs).toBe(60_000);
    expect(branchLiveness(activity({ lastActivity: ago(-5_000) }), NOW).idleMs).toBe(0);
  });
});

describe('familyLiveness', () => {
  const at = (state: 'running' | 'quiet' | 'finished' | 'unknown', lastActivity: string | null) =>
    branchLiveness(
      {
        lastActivity,
        nodes: state === 'finished' ? [node('done')] : [node('tool')],
        reported: false,
      },
      state === 'quiet' ? NOW + QUIET_AFTER_MS * 2 : NOW,
    );

  it('is unknown for an empty family — no match is not evidence of no work', () => {
    const rolled = familyLiveness([]);
    expect(rolled.state).toBe('unknown');
    expect(rolled.terminal).toBe(false);
  });

  it('takes the strongest claim: one live branch makes the family live', () => {
    expect(familyLiveness([at('finished', ago(0)), at('quiet', ago(0)), at('running', ago(0))]).state).toBe('running');
    expect(familyLiveness([at('finished', ago(0)), at('quiet', ago(0))]).state).toBe('quiet');
  });

  it('is finished only once every branch has handed back', () => {
    const all = familyLiveness([at('finished', ago(0)), at('finished', ago(1_000))]);
    expect(all.state).toBe('finished');
    expect(all.terminal).toBe(true);
    expect(familyLiveness([at('finished', ago(0)), at('running', ago(0))]).terminal).toBe(false);
  });

  it('reports the newest activity in the family', () => {
    const rolled = familyLiveness([at('running', ago(5 * 60_000)), at('running', ago(30_000))]);
    expect(rolled.lastActivity).toBe(ago(30_000));
    expect(rolled.idleMs).toBe(30_000);
  });
});
