import { describe, expect, it } from 'vitest';
import { parseSessionNodes, parseSessionTranscript } from '../src/sessions.js';
import {
  type BucketBreakdownInput,
  bucketSessions,
  errorSignature,
  isDiscoveryCall,
  type SuggestibleSession,
  sessionSuggestionBuckets,
  suggestBucket,
  suggestFromBreakdown,
  summarizeBreakdownPatterns,
  toolName,
} from '../src/suggestions.js';

/** Build a session the rules can read, from real transcript text. */
function session(
  threadId: string,
  started: string | null,
  body: string[],
  header: { sessionId?: string; subtitle?: string } = {},
): SuggestibleSession {
  const content = [
    '',
    `# Session ${threadId}`,
    '- model: claude-opus-5',
    `- session: ${header.sessionId ?? `sess-${threadId}`}`,
    ...(started ? [`- started: ${started}`] : []),
    '- title: A session',
    ...(header.subtitle ? [`- subtitle: ${header.subtitle}`] : []),
    '',
    ...body,
  ].join('\n');
  return { ...parseSessionTranscript(threadId, content), nodes: parseSessionNodes(content) };
}

/** The far side of a compaction: a fresh thread id, the same `- session:` uuid, the summary replayed. */
function continued(threadId: string, started: string, sessionId: string, body: string[]): SuggestibleSession {
  return session(threadId, started, body, {
    sessionId,
    subtitle:
      'This session is being continued from a previous conversation that ran out of context. Summary: the earlier portion.',
  });
}

/** The same transcript run as somebody's subagent, with the report its caller did or didn't get. */
function subagent(threadId: string, started: string | null, body: string[], reported: boolean): SuggestibleSession {
  return { ...session(threadId, started, body), depth: 1, reported };
}

const day = (n: number) => `2026-07-${String(n).padStart(2, '0')}T10:00:00.000Z`;

describe('signature helpers', () => {
  it('pulls the tool name out of a truncated call signature', () => {
    expect(toolName('Read(file_path=/repo/src/a…')).toBe('Read');
    expect(toolName('Bash(command=npm test)')).toBe('Bash');
    expect(toolName(null)).toBeNull();
    expect(toolName('- not a call')).toBeNull();
  });

  it('counts reads, searches and inspecting shell commands as discovery', () => {
    expect(isDiscoveryCall('Read(file_path=/a.ts)')).toBe(true);
    expect(isDiscoveryCall('Grep(pattern=foo)')).toBe(true);
    expect(isDiscoveryCall('Bash(command=git status)')).toBe(true);
    expect(isDiscoveryCall('Bash(command=npm run build)')).toBe(false);
    expect(isDiscoveryCall('Edit(file_path=/a.ts)')).toBe(false);
  });

  it('reads the whole shell pipeline, so a mutation is never discovery for riding with a read', () => {
    // Each of these matches an inspecting verb on a word doing none of the work.
    expect(isDiscoveryCall('Bash(command=pnpm test 2>&1 | tail -40)')).toBe(false);
    expect(isDiscoveryCall('Bash(command=git add -A && git status --short)')).toBe(false);
    expect(isDiscoveryCall('Bash(command=git commit -m "wip" && git log -1)')).toBe(false);
    expect(isDiscoveryCall('Bash(command=ls -R src > /tmp/tree.txt)')).toBe(false);
    expect(isDiscoveryCall('Bash(command=rm -rf dist; ls dist)')).toBe(false);
    // …while a genuinely read-only pipeline still is.
    expect(isDiscoveryCall('Bash(command=cat docs/index.md | head -40)')).toBe(true);
    expect(isDiscoveryCall('Bash(command=git diff --stat | wc -l)')).toBe(true);
  });

  it("collapses an error's wording to what recurs", () => {
    expect(errorSignature('File not found: /a/b.ts')).toBe(errorSignature('File not found: /c/d.ts'));
    expect(errorSignature('Exit code 1')).toBe(errorSignature('Exit code 2'));
    expect(errorSignature('Permission denied')).not.toBe(errorSignature('File not found'));
  });
});

describe('bucketSessions', () => {
  it('groups ten at a time, oldest first, with the remainder last', () => {
    const sessions = Array.from({ length: 23 }, (_, i) => ({
      threadId: `t${String(i).padStart(2, '0')}`,
      started: day(i + 1),
    }));
    const buckets = bucketSessions([...sessions].reverse());
    expect(buckets.map((b) => b.length)).toEqual([10, 10, 3]);
    expect(buckets[0]![0]!.threadId).toBe('t00');
    expect(buckets[2]![2]!.threadId).toBe('t22');
  });

  it('orders sessions without a start time by thread id rather than dropping them', () => {
    const buckets = bucketSessions([
      { threadId: 'b', started: null },
      { threadId: 'a', started: null },
    ]);
    expect(buckets[0]!.map((s) => s.threadId)).toEqual(['a', 'b']);
  });
});

describe('suggestBucket', () => {
  it('flags guardrail refusals as high severity and names the sessions they hit', () => {
    const sessions = [
      session('a1', day(1), [
        '## Task: One',
        '- Bash(command=rm -rf /)',
        '- ✗ Permission denied by hook',
        '- done: ok',
      ]),
      session('a2', day(2), ['## Task: Two', '- Bash(command=curl x)', '- ✗ Blocked: tool not allowed', '- done: ok']),
    ];
    const blocked = suggestBucket(sessions).find((s) => s.id === 'blocked-guardrails');
    expect(blocked).toBeDefined();
    expect(blocked!.severity).toBe('high');
    expect(blocked!.sources.map((s) => s.threadId).sort()).toEqual(['a1', 'a2']);
  });

  it('reports an error that recurs across sessions once, with its occurrence count', () => {
    const sessions = [
      session('b1', day(1), [
        '## Task: One',
        '- Bash(command=pnpm test)',
        '- ✗ ENOENT: no such file /a.ts',
        '- done: ok',
      ]),
      session('b2', day(2), [
        '## Task: Two',
        '- Bash(command=pnpm test)',
        '- ✗ ENOENT: no such file /b.ts',
        '- done: ok',
      ]),
    ];
    const repeated = suggestBucket(sessions).find((s) => s.id === 'repeated-errors');
    expect(repeated).toBeDefined();
    expect(repeated!.evidence).toContain('2 occurrences');
  });

  /** One assistant turn's calls: the first marked, the rest riding along in that same turn. */
  const turn = (...calls: string[]) => calls.map((c, i) => (i === 0 ? `- ▸ ${c}` : `- ${c}`));

  const serialDiscoveryIn = (s: SuggestibleSession) => suggestBucket([s]).find((r) => r.id === 'serial-discovery');

  it('flags a run of turns that each spent their whole round-trip on one read', () => {
    const serial = session('c1', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/a.ts)'),
      ...turn('Read(file_path=/b.ts)'),
      ...turn('Grep(pattern=foo)'),
      ...turn('Read(file_path=/c.ts)'),
      '- done: ok',
    ]);
    const flagged = serialDiscoveryIn(serial);
    expect(flagged).toBeDefined();
    expect(flagged!.evidence).toContain('4 single-call turns');
  });

  it('never flags reads that went out together, however many one turn issued', () => {
    const batched = session('c2', day(1), [
      '## Task: One',
      ...turn(...Array.from({ length: 10 }, (_, i) => `Read(file_path=/f${i}.ts)`)),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(batched)).toBeUndefined();

    // Nor does a string of batched turns add up to a run — each one is still one round-trip.
    const batches = session('c3', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/a.ts)', 'Read(file_path=/b.ts)'),
      ...turn('Read(file_path=/c.ts)', 'Read(file_path=/d.ts)'),
      ...turn('Read(file_path=/e.ts)', 'Read(file_path=/f.ts)'),
      ...turn('Read(file_path=/g.ts)', 'Read(file_path=/h.ts)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(batches)).toBeUndefined();
  });

  it('breaks a run on a result the next turn had to wait for', () => {
    // An errored result did come back in between, so the next read reacted to it.
    const reacted = session('c5', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/a.ts)'),
      ...turn('Read(file_path=/b.ts)'),
      '- ✗ ENOENT: no such file /b.ts',
      ...turn('Read(file_path=/c.ts)'),
      ...turn('Read(file_path=/d.ts)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(reacted)).toBeUndefined();
  });

  it('breaks a run on reasoning recorded between two turns', () => {
    // Reasoning between two turns records that the agent read what came back first.
    const reasoned = session('c4', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/a.ts)'),
      '- decided: Now I know where to look.',
      ...turn('Read(file_path=/b.ts)'),
      ...turn('Read(file_path=/c.ts)'),
      ...turn('Read(file_path=/d.ts)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(reasoned)).toBeUndefined();
  });

  it('never flags a chain whose every step was chosen from the step before it', () => {
    // A file that isn't on this branch: every argument comes from the previous result, and
    // the transcript narrates each hop.
    const chained = session('c7', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/repo/docs/specs/thing.md)'),
      '- ✗ File does not exist',
      ...turn('Bash(command=find docs -iname "*thing*")'),
      '- decided: It is not on main — it lives on the spec branch.',
      ...turn('Bash(command=git show docs/spec-branch --stat)'),
      ...turn('Bash(command=git show docs/spec-branch:docs/specs/thing.md)'),
      ...turn('Read(file_path=/repo/tmp/spec.md)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(chained)).toBeUndefined();

    // The same shape in a verification tail: each gate was picked from the failure of the last.
    const gates = session('c8', day(1), [
      '## Task: One',
      ...turn('Bash(command=cat gates.json)'),
      '- decided: Gate names differ here. Running biome directly.',
      ...turn('Bash(command=git diff --stat)'),
      '- decided: A sibling worktree nested a biome.json — scoping to real source paths.',
      ...turn('Bash(command=git status --short)'),
      '- decided: Clean. Now the docs index check.',
      ...turn('Bash(command=ls docs)'),
      ...turn('Bash(command=cat docs/index.md)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(gates)).toBeUndefined();
  });

  it('never flags a wait — the same target polled while a background job writes it', () => {
    // Parallelizing a wait is meaningless by construction, and one file read over and over is
    // `redundant-reads`' finding rather than this one.
    const polling = session('c12', day(1), [
      '## Task: One',
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      ...turn('Bash(command=grep -c "elapsed_steps" /tmp/run.log)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(polling)).toBeUndefined();

    // Alternating between two files it is waiting on is the same wait, not a batchable set.
    const twoFiles = session('c13', day(1), [
      '## Task: One',
      ...turn('Read(file_path=/tmp/a.log)'),
      ...turn('Read(file_path=/tmp/b.log)'),
      ...turn('Read(file_path=/tmp/a.log)'),
      ...turn('Read(file_path=/tmp/b.log)'),
      ...turn('Read(file_path=/tmp/a.log)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(twoFiles)).toBeUndefined();
  });

  it('never flags a probe that narrowed onto the path the call before it turned up', () => {
    // An unfamiliar layout: each answer chose the next path, so none of these arguments could
    // have been written before its predecessor came back.
    const probe = session('c14', day(1), [
      '## Task: One',
      ...turn('Bash(command=ls /repo)'),
      ...turn('Bash(command=ls /repo/server)'),
      ...turn('Bash(command=ls /repo/server/src)'),
      ...turn('Bash(command=ls /repo/server/src/db)'),
      ...turn('Read(file_path=/repo/server/src/db/ingest.ts)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(probe)).toBeUndefined();
  });

  it('never flags a run of calls that changed the tree', () => {
    // A post-merge pipeline and a verification tail: every one of these matches an inspecting
    // verb on a word doing none of the work.
    const mutating = session('c15', day(1), [
      '## Task: One',
      ...turn('Bash(command=pnpm typecheck 2>&1 | tail -20)'),
      ...turn('Bash(command=pnpm test 2>&1 | tail -40)'),
      ...turn('Bash(command=pnpm build 2>&1 | tail -20)'),
      ...turn('Bash(command=git add -A && git status --short)'),
      ...turn('Bash(command=git commit -m "ship" && git log -1 --stat)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(mutating)).toBeUndefined();
  });

  it('still flags the runs the transcripts confirm — bare single-call turns', () => {
    // A subagent walking the tree one call at a time with no reasoning between any of them.
    const explore = session('c9', day(1), [
      '## Task: One',
      ...turn('Bash(command=ls docs/features)'),
      ...turn('Bash(command=grep -rn "palette" docs)'),
      ...turn('Bash(command=grep -rn "ramp" docs)'),
      ...turn('Bash(command=grep -rn "token" docs)'),
      ...turn('Bash(command=head -80 docs/features/color.md)'),
      ...turn('Bash(command=grep -rn "chart" docs)'),
      '- decided: I have enough material now.',
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(explore)!.evidence).toContain('6 single-call turns');

    // Targets an opening batch had already named, then walked one per turn.
    const known = session('c10', day(1), [
      '## Task: One',
      ...turn('Bash(command=rg -n "no GitHub remote found")', 'Bash(command=git remote -v)'),
      ...turn('Read(file_path=/repo/server/src/github.ts)'),
      ...turn('Bash(command=rg -n "parseRepoSlug" -A 30)'),
      ...turn('Bash(command=rg -n -A5 -i "host github-personal" ~/.ssh/config)'),
      ...turn('Bash(command=rg -n "REPO_SLUG|GITHUB_REPO")'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(known)!.evidence).toContain('4 single-call turns');

    // The per-file loop: one Read per turn over a list that arrived complete in one call.
    const perFile = session('c11', day(1), [
      '## Task: One',
      ...turn('Bash(command=git diff --name-only origin/main)'),
      ...turn('Read(file_path=/repo/a.ts)'),
      ...turn('Read(file_path=/repo/b.ts)'),
      ...turn('Read(file_path=/repo/c.ts)'),
      ...turn('Read(file_path=/repo/d.ts)'),
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(perFile)!.evidence).toContain('5 single-call turns');
  });

  it('says nothing about a transcript written before turn boundaries were recorded', () => {
    // Unmarked calls carry no turn, and an unknown boundary is not evidence of a serial one.
    const legacy = session('c6', day(1), [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Read(file_path=/b.ts)',
      '- Grep(pattern=foo)',
      '- Read(file_path=/c.ts)',
      '- Read(file_path=/d.ts)',
      '- done: ok',
    ]);
    expect(serialDiscoveryIn(legacy)).toBeUndefined();
  });

  it('flags a file read three times in one session', () => {
    const s = session('d1', day(1), [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Edit(file_path=/a.ts)',
      '- Read(file_path=/a.ts)',
      '- Edit(file_path=/a.ts)',
      '- Read(file_path=/a.ts)',
      '- done: ok',
    ]);
    const redundant = suggestBucket([s]).find((r) => r.id === 'redundant-reads');
    expect(redundant).toBeDefined();
    expect(redundant!.sources[0]!.threadId).toBe('d1');
  });

  it('separates reads whose display signature was truncated to the same prefix', () => {
    // The recorded signature is one truncated argument, so three different files under a
    // long path render identically. Keying on the proxy's hash of the full arguments is
    // what stops that reading as the same file read three times.
    const body = [
      '## Task: One',
      '- Read(file_path=/Users/x/.claude/worktrees/feat-someth…',
      '- Read(file_path=/Users/x/.claude/worktrees/feat-someth…',
      '- Read(file_path=/Users/x/.claude/worktrees/feat-someth…',
      '- done: ok',
    ];
    const distinct: SuggestibleSession = {
      ...session('d2', day(1), body),
      nodes: session('d2', day(1), body).nodes.map((n, i) => (n.type === 'tool' ? { ...n, argsHash: `hash${i}` } : n)),
    };
    expect(suggestBucket([distinct]).find((r) => r.id === 'redundant-reads')).toBeUndefined();

    // Same three lines, one hash: genuinely the same call, and it still fires.
    const same: SuggestibleSession = {
      ...distinct,
      threadId: 'd3',
      nodes: distinct.nodes.map((n) => (n.type === 'tool' ? { ...n, argsHash: 'sameargs' } : n)),
    };
    expect(suggestBucket([same]).find((r) => r.id === 'redundant-reads')).toBeDefined();
  });

  it('counts a top-level task with no outcome line as unfinished', () => {
    const sessions = [
      session('e1', day(1), ['## Task: One', '- Read(file_path=/a.ts)']),
      session('e2', day(2), ['## Task: Two', '- Read(file_path=/b.ts)']),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished).toBeDefined();
    expect(unfinished!.evidence).toBe('2 of 2 top-level tasks have no outcome line');
  });

  it('leaves an inline-nested Skill run out of the task counts entirely', () => {
    // `/clean` and `/pr` invoked inline each open a `## Task:` in the caller's transcript
    // and are forbidden from spending the text-only turn a `done:` is written from, so
    // counting them makes one closed task read as three abandoned ones.
    const sessions = [
      session('e1', day(1), [
        '## Task: Ship it',
        '- Skill(skill=clean)',
        '## Task: Clean up the comments in my changes.',
        '- Edit(file_path=/a.ts)',
        '- Skill(skill=pr)',
        '## Task: You have explicit permission to write the PR description.',
        '- Bash(command=gh pr create)',
        '- done: opened PR #12',
      ]),
      session('e2', day(2), ['## Task: Two', '- Read(file_path=/b.ts)', '- done: ok']),
    ];
    expect(suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks')).toBeUndefined();
  });

  it('still counts the enclosing task when a nested run is the last thing in it', () => {
    // The nested opens must not become the open task themselves — the session's own
    // task is the one with no outcome, and it is the one that must be reported.
    const sessions = [
      session('e1', day(1), ['## Task: Ship it', '- Skill(skill=clean)', '## Task: Clean up the comments.']),
      session('e2', day(2), ['## Task: Ship it too', '- Skill(skill=pr)', '## Task: Write the PR description.']),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished!.evidence).toBe('2 of 2 top-level tasks have no outcome line');
    expect(unfinished!.sources.map((s) => s.sample)).toEqual(['Ship it', 'Ship it too']);
  });

  it('counts a slash command the user typed as a genuine top-level task', () => {
    // `<command-name>` marks a command the *user* invoked — the opposite of a nested run,
    // and no `Skill(…)` call precedes it.
    const sessions = [
      session('e1', day(1), ['## Task: <command-name>/task</command-name> fix the thing', '- Read(file_path=/a.ts)']),
      session('e2', day(2), ['## Task: <command-name>/god</command-name> ship the thing', '- Read(file_path=/b.ts)']),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished!.evidence).toBe('2 of 2 top-level tasks have no outcome line');
  });

  it('leaves a subagent that reported back out of the unfinished count', () => {
    const sessions = [
      session('e1', day(1), ['## Task: One', '- Agent(subagent_type=Explore)']),
      subagent('e2', day(2), ['## Task: Search', '- Read(file_path=/b.ts)'], true),
      subagent('e3', day(3), ['## Task: Search again', '- Read(file_path=/c.ts)'], true),
    ];
    // Only the top-level task is outstanding, so the rule stays below its threshold.
    expect(suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks')).toBeUndefined();
  });

  it('counts a subagent that stopped without reporting back as unfinished', () => {
    const sessions = [
      session('e1', day(1), ['## Task: One', '- Agent(subagent_type=Explore)', '- done: ok']),
      subagent('e2', day(2), ['## Task: Search', '- Read(file_path=/b.ts)'], false),
      subagent('e3', day(3), ['## Task: Clean then PR', '- Bash(command=gh pr view 42)'], false),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished).toBeDefined();
    // Each source points at the last step, where the thread went quiet.
    expect(unfinished!.sources.map((s) => s.threadId)).toEqual(['e2', 'e3']);
    expect(unfinished!.sources[1]!.sample).toContain('gh pr view 42');
  });

  it('reports the two populations apart, never as one number', () => {
    const sessions = [
      session('e1', day(1), ['## Task: One', '- Read(file_path=/a.ts)']),
      session('e2', day(2), ['## Task: Two', '- Agent(subagent_type=Explore)', '- done: ok']),
      subagent('e3', day(3), ['## Task: Search', '- Read(file_path=/b.ts)'], false),
      subagent('e4', day(4), ['## Task: Search again', '- Read(file_path=/c.ts)'], true),
    ];
    const unfinished = suggestBucket(sessions).find((s) => s.id === 'unfinished-tasks');
    expect(unfinished!.evidence).toBe(
      '1 of 2 top-level tasks have no outcome line; 1 of 2 subagent threads stopped without reporting back',
    );
  });

  it('names only the population a bucket actually has', () => {
    const subagentsOnly = [
      subagent('e1', day(1), ['## Task: Search', '- Read(file_path=/b.ts)'], false),
      subagent('e2', day(2), ['## Task: Search again', '- Read(file_path=/c.ts)'], false),
    ];
    expect(suggestBucket(subagentsOnly).find((s) => s.id === 'unfinished-tasks')!.evidence).toBe(
      '2 of 2 subagent threads stopped without reporting back',
    );
  });

  it("blames the tool that owns most of a bucket's failures", () => {
    const s = session('f1', day(1), [
      '## Task: One',
      '- Bash(command=pnpm test)',
      '- ✗ exit 1',
      '- Bash(command=pnpm build)',
      '- ✗ exit 2',
      '- Read(file_path=/a.ts)',
      '- ✗ file missing',
      '- done: ok',
    ]);
    const blamed = suggestBucket([s]).find((r) => r.id === 'error-prone-tool');
    expect(blamed).toBeDefined();
    expect(blamed!.title).toContain('Bash');
  });

  it('says so plainly when nothing trips a threshold', () => {
    const s = session('g1', day(1), ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']);
    expect(suggestBucket([s]).map((r) => r.id)).toEqual(['steady']);
  });

  it('orders suggestions most severe first', () => {
    const sessions = [
      session('h1', day(1), [
        '## Task: One',
        '- Read(file_path=/a.ts)',
        '- Read(file_path=/b.ts)',
        '- Read(file_path=/c.ts)',
        '- Read(file_path=/d.ts)',
        '- ✗ Permission denied',
        '- ✗ Permission denied',
        '- done: ok',
      ]),
    ];
    const ids = suggestBucket(sessions).map((r) => r.severity);
    expect(ids[0]).toBe('high');
  });

  it('returns nothing for an empty bucket', () => {
    expect(suggestBucket([])).toEqual([]);
  });
});

describe('threads recorded twice across a compaction', () => {
  const blocked = ['## Task: One', '- Bash(command=curl x)', '- ✗ Blocked: tool not allowed', '- done: ok'];

  it('counts one real thread once, however many thread ids the compaction gave it', () => {
    // Two transcripts, one `- session:` uuid — the shape of bucket 76's 271b995a/3f4dac00 pair.
    // Summed over both, the single refusal in it reads as two and trips the rule.
    const pair = [continued('e1', day(1), 'uuid-1', blocked), continued('e2', day(2), 'uuid-1', blocked)];
    expect(suggestBucket(pair).find((s) => s.id === 'blocked-guardrails')).toBeUndefined();

    // Two genuinely different threads with the same refusal still trip it.
    const distinct = [session('e3', day(1), blocked), session('e4', day(2), blocked)];
    expect(suggestBucket(distinct).find((s) => s.id === 'blocked-guardrails')).toBeDefined();
  });

  it('keeps the fuller recording of the pair', () => {
    const short = continued('e5', day(1), 'uuid-2', ['## Task: One', '- Read(file_path=/a.ts)']);
    const full = continued('e6', day(2), 'uuid-2', [
      '## Task: One',
      '- Read(file_path=/a.ts)',
      '- Read(file_path=/b.ts)',
      '- ✗ Blocked: tool not allowed',
      '- ✗ Permission denied by hook',
      '- done: ok',
    ]);
    const kept = suggestBucket([short, full]).find((s) => s.id === 'blocked-guardrails');
    expect(kept!.sources.map((s) => s.threadId)).toEqual(['e6']);
  });

  it('leaves a subagent alone, though it shares its caller uuid', () => {
    // A subagent opens on its own task prompt, never on the continuation preamble.
    const caller = session('e7', day(1), blocked, { sessionId: 'uuid-3' });
    const spawned = session('e8', day(2), blocked, { sessionId: 'uuid-3' });
    expect(suggestBucket([caller, spawned]).find((s) => s.id === 'blocked-guardrails')).toBeDefined();
  });

  it('dedupes the counting without renumbering or reshaping the windows', () => {
    const sessions = [
      session('f0', day(1), ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']),
      continued('f1', day(2), 'uuid-4', ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']),
      continued('f2', day(3), 'uuid-4', ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']),
    ];
    const bucket = sessionSuggestionBuckets(sessions)[0]!;
    // Membership and numbering are untouched — recorded verdicts point at these.
    expect(bucket.index).toBe(1);
    expect(bucket.label).toBe('1–3');
    expect(bucket.threadIds).toEqual(['f0', 'f1', 'f2']);
    // …but the arithmetic sees two threads, not three.
    expect(bucket.stats.sessions).toBe(2);
    expect(bucket.stats.tasks).toBe(2);
    expect(bucket.stats.tools).toBe(2);
  });
});

describe('sessionSuggestionBuckets', () => {
  it('numbers windows from the oldest session and lists the newest bucket first', () => {
    const sessions = Array.from({ length: 12 }, (_, i) =>
      session(`s${String(i).padStart(2, '0')}`, day(i + 1), ['## Task: One', '- Edit(file_path=/a.ts)', '- done: ok']),
    );
    const buckets = sessionSuggestionBuckets(sessions);
    expect(buckets.map((b) => b.label)).toEqual(['11–12', '1–10']);
    expect(buckets[1]!.index).toBe(1);
    expect(buckets[1]!.threadIds[0]).toBe('s00');
    expect(buckets[0]!.stats.sessions).toBe(2);
    expect(buckets[0]!.startedFirst).toBe(day(11));
  });

  it('has no buckets when there are no sessions', () => {
    expect(sessionSuggestionBuckets([])).toEqual([]);
  });
});

describe('summarizeBreakdownPatterns', () => {
  const input = (threadId: string, toolBytes: number): BucketBreakdownInput => ({
    threadId,
    file: `${threadId}.request.txt`,
    realInput: 1_000,
    breakdown: {
      totalBytes: 1_000,
      systemBytes: 200,
      toolsBytes: toolBytes,
      toolCount: 1,
      messageCount: 1,
      tools: [{ index: 0, name: 'Workflow', bytes: toolBytes, estTokens: toolBytes / 4 }],
      messages: [{ index: 0, role: 'user', bytes: 300, estTokens: 75 }],
    },
  });

  it('rolls regions and tool schemas up across requests, largest first', () => {
    const summary = summarizeBreakdownPatterns([input('a', 400), input('b', 500)]);
    expect(summary.requests).toBe(2);
    expect(summary.avgToolsBytes).toBe(450);
    const workflow = summary.patterns.find((p) => p.name === 'Workflow');
    expect(workflow).toMatchObject({ kind: 'tool', requests: 2, avgBytes: 450 });
    expect(workflow!.avgPctOfRequest).toBe(45);
    expect(summary.patterns[0]!.avgBytes).toBeGreaterThanOrEqual(summary.patterns[1]!.avgBytes);
  });

  it('is empty rather than NaN with no inputs', () => {
    const summary = summarizeBreakdownPatterns([]);
    expect(summary).toMatchObject({ requests: 0, avgTotalBytes: 0, maxRealInput: 0, patterns: [] });
  });

  it('flags schemas that dominate the request and a tool present in every one', () => {
    const suggestions = suggestFromBreakdown(summarizeBreakdownPatterns([input('a', 500), input('b', 500)]));
    expect(suggestions.map((s) => s.id).sort()).toEqual(['bucket-constant-tool', 'bucket-tool-schema-heavy']);
    const constant = suggestions.find((s) => s.id === 'bucket-constant-tool')!;
    expect(constant.title).toContain('Workflow');
    expect(constant.sources).toHaveLength(2);
  });

  it('names the requests the schema-heavy claim was measured from', () => {
    const summary = summarizeBreakdownPatterns([input('a', 400), input('b', 500)]);
    expect(summary.toolsSources.map((s) => s.threadId)).toEqual(['b', 'a']); // heaviest first

    const heavy = suggestFromBreakdown(summary).find((s) => s.id === 'bucket-tool-schema-heavy')!;
    expect(heavy.sources.map((s) => s.threadId)).toEqual(['b', 'a']);
    expect(heavy.sources.map((s) => s.label)).toEqual(['b.request.txt', 'a.request.txt']);
    expect(heavy.sources[0]!.sample).toBe('500 bytes of tool schemas');
  });

  it('suggests nothing from an empty breakdown', () => {
    expect(suggestFromBreakdown(summarizeBreakdownPatterns([]))).toEqual([]);
  });
});
