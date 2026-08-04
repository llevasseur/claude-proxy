import { describe, expect, it } from 'vitest';
import {
  attributeSteps,
  COMMAND_RUN_SCHEMA,
  type CommandRun,
  type CommandRunStepStats,
  type CommandStep,
  classifyOutcome,
  commandRunShapes,
  contentHash,
  countWaste,
  detectPatterns,
  filterRunsByFlags,
  findNestedInvocations,
  isCommandRun,
  nestedCommandOf,
  nestedRunId,
  parseCommandEnvelope,
  parseCommandSteps,
  patternFrequency,
  reachedEnd,
  runKey,
  runTotals,
  stepReach,
  summarizeCommands,
  summarizeSteps,
  ZERO_TOKENS,
  ZERO_WASTE,
} from '../src/commands.js';
import type { SessionNode } from '../src/sessions.js';

/** A transcript node, with the fields these rules read. */
function node(index: number, type: SessionNode['type'], text: string, tool: string | null = null): SessionNode {
  return { index, type, text, tool, task: null, interruption: null, interrupted: false, message: null };
}

const decision = (i: number, text: string) => node(i, 'decision', text);
const tool = (i: number, sig: string) => node(i, 'tool', sig, sig);

describe('parseCommandSteps', () => {
  it('reads the headings in document order', () => {
    const steps = parseCommandSteps(
      ['# Task', '## Step 1 — Set up the workspace', 'prose', '## Step 2 — Implement the task', ''].join('\n'),
    );
    expect(steps).toEqual([
      { id: '1', order: 1, title: 'Set up the workspace', artifacts: [] },
      { id: '2', order: 2, title: 'Implement the task', artifacts: [] },
    ]);
  });

  // `/task` really does declare a `## Step 1.5 — Bootstrap the worktree`.
  it('keeps a decimal step, and sorts it between its neighbours', () => {
    const steps = parseCommandSteps(
      ['## Step 1 — Set up', '## Step 1.5 — Bootstrap the worktree', '## Step 2 — Implement'].join('\n'),
    );
    expect(steps.map((s) => s.id)).toEqual(['1', '1.5', '2']);
    expect(steps.map((s) => s.order)).toEqual([1, 1.5, 2]);
    expect([...steps].sort((a, b) => a.order - b.order).map((s) => s.id)).toEqual(['1', '1.5', '2']);
  });

  it('accepts a step numbered from zero', () => {
    expect(parseCommandSteps('## Step 0 — Incorporate added commands')[0]).toMatchObject({
      id: '0',
      order: 0,
      title: 'Incorporate added commands',
    });
  });

  it("mines the invocations a step's body prescribes, and ignores its bare nouns", () => {
    const [step] = parseCommandSteps(
      [
        '## Step 1 — Set up',
        'Run `my-command-tools worktree begin --branch <name> --bootstrap`, which reports the',
        '`path` it created and the `base` it used. Then switch with the `EnterWorktree` tool.',
        "Later, `/clean` is not this step's job. Fall back to `scripts/bootstrap-worktree.sh`.",
        '## Step 2 — Next',
      ].join('\n'),
    );
    expect(step?.artifacts).toEqual(
      expect.arrayContaining([
        { kind: 'shell', value: 'my-command-tools worktree begin' },
        { kind: 'tool', value: 'EnterWorktree' },
        { kind: 'skill', value: 'clean' },
        { kind: 'shell', value: 'scripts/bootstrap-worktree.sh' },
      ]),
    );
    // `path` and `base` are nouns, not invocations.
    expect(step?.artifacts?.map((a) => a.value)).not.toContain('path');
    expect(step?.artifacts?.map((a) => a.value)).not.toContain('base');
  });

  // `Edit` alone matched 211 calls across the real `/task` runs — every step mentions
  // the ambient tools as advice, so taking them as anchors swamps the real boundaries.
  it('ignores ambient tools and shouted words, but keeps a step-specific tool', () => {
    const [step] = parseCommandSteps(
      ['## Step 1 — A', 'Read before `Edit`, use `Bash`, spawn an `Agent`, check `HEAD`, call `EnterWorktree`.'].join(
        '\n',
      ),
    );
    expect(step?.artifacts).toEqual([{ kind: 'tool', value: 'EnterWorktree' }]);
  });

  it("keeps a step's body out of the next step's artifacts", () => {
    const steps = parseCommandSteps(
      ['## Step 1 — A', 'run `pnpm install` here', '## Step 2 — B', 'run `my-command-tools verify` here'].join('\n'),
    );
    expect(steps[0]?.artifacts).toEqual([{ kind: 'shell', value: 'pnpm install' }]);
    expect(steps[1]?.artifacts).toEqual([{ kind: 'shell', value: 'my-command-tools verify' }]);
  });

  it("stops a step's body at an unrelated heading", () => {
    const steps = parseCommandSteps(
      ['## Step 1 — A', 'run `pnpm install`', '## Notes', 'run `gh pr create`'].join('\n'),
    );
    expect(steps[0]?.artifacts).toEqual([{ kind: 'shell', value: 'pnpm install' }]);
  });

  it('merges a step whose heading repeats, rather than declaring it twice', () => {
    const steps = parseCommandSteps(['## Step 1 — A', '`pnpm install`', '## Step 1 — A again', '`npm ci`'].join('\n'));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.artifacts?.map((a) => a.value)).toEqual(['pnpm install', 'npm ci']);
  });

  it('accepts hyphen and colon separators, and a bare heading', () => {
    const steps = parseCommandSteps(['## Step 1 - Dash', '## Step 2: Colon', '## Step 3'].join('\n'));
    expect(steps.map((s) => s.title)).toEqual(['Dash', 'Colon', '']);
  });

  // `/clean` declares no steps; `/pr` has one bare `## Steps` list heading.
  it('yields an empty catalogue for a command with no numbered steps', () => {
    expect(parseCommandSteps('# Clean\n\nTidy the branch.\n')).toEqual([]);
    expect(parseCommandSteps('# PR\n\n## Steps\n\n1. Push\n2. Open\n')).toEqual([]);
  });
});

describe('contentHash', () => {
  it('is stable, and changes when the file changes', () => {
    expect(contentHash('## Step 1 — Go')).toBe(contentHash('## Step 1 — Go'));
    expect(contentHash('## Step 1 — Go')).not.toBe(contentHash('## Step 1 — Go.'));
    expect(contentHash('ab')).not.toBe(contentHash('ba'));
    expect(contentHash('anything')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('handles an empty file', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('parseCommandEnvelope', () => {
  const envelope = (name: string, args: string) =>
    `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`;

  it('reads the command, args and leading flags', () => {
    const parsed = parseCommandEnvelope(envelope('task', '--sub --draft Build the commands page'));
    expect(parsed).toMatchObject({
      command: 'task',
      flags: ['sub', 'draft'],
      prompt: '--sub --draft Build the commands page',
    });
  });

  it('stops reading flags at the first word of the criteria', () => {
    // `main` is --base's value, not a flag, and `--force` is criteria prose past it.
    const parsed = parseCommandEnvelope(envelope('task', '--base main do not --force anything'));
    expect(parsed?.flags).toEqual(['base']);
  });

  it('reads a short flag', () => {
    expect(parseCommandEnvelope(envelope('task', '-h fix the scroll'))?.flags).toEqual(['h']);
  });

  it('has no flags when the criteria lead', () => {
    expect(parseCommandEnvelope(envelope('review', 'look at the diff --hard'))?.flags).toEqual([]);
  });

  it('returns null for a session that is not a command run', () => {
    expect(parseCommandEnvelope('just a normal prompt')).toBeNull();
    expect(parseCommandEnvelope('')).toBeNull();
    expect(parseCommandEnvelope(null)).toBeNull();
  });

  it('strips the local-command caveat and injected reminders out of the prompt', () => {
    const raw =
      '<command-name>/task</command-name><command-args><local-command-caveat>ignored</local-command-caveat>Ship it</command-args>' +
      '<system-reminder>background context</system-reminder>';
    const parsed = parseCommandEnvelope(raw);
    expect(parsed?.prompt).toBe('Ship it');
    expect(parsed?.command).toBe('task');
  });

  it('lowercases the name and tolerates a missing slash', () => {
    expect(parseCommandEnvelope('<command-name>Task</command-name>')?.command).toBe('task');
  });

  /** Verbatim shape of what the CLI sends when a local command opens a turn. */
  const local = (name: string) =>
    '<local-command-caveat>Caveat: The messages below were generated by the user while running local ' +
    'commands. DO NOT respond to these messages or otherwise consider them in your response unless the ' +
    `user explicitly asks you to.</local-command-caveat> <command-name>/${name}</command-name> ` +
    `<command-message>${name}</command-message> <command-args></command-args> <local-command-stdout></local-command-stdout>`;

  it('is not a run when the only command was a local one', () => {
    expect(parseCommandEnvelope(local('clear'))).toBeNull();
    expect(parseCommandEnvelope(`${local('clear')} Strange, the overview page shows nothing today.`)).toBeNull();
  });

  it('reads past a local command to the real one typed after it', () => {
    const parsed = parseCommandEnvelope(`${local('clear')} ${envelope('mc', '-t feat/command-toolkit-cli')}`);
    expect(parsed).toMatchObject({
      command: 'mc',
      flags: ['t'],
      args: '-t feat/command-toolkit-cli',
    });
  });

  // An envelope quoted inside the args is criteria prose, not the next run.
  it('keeps args that quote another envelope inside them', () => {
    const parsed = parseCommandEnvelope(
      envelope('task', 'make <command-name>/clean</command-name> and <command-name>/pr</command-name> trackable'),
    );
    expect(parsed?.command).toBe('task');
    expect(parsed?.prompt).toBe('make /clean and /pr trackable');
  });

  it("reads each envelope's own args, not the first block in the prompt", () => {
    expect(parseCommandEnvelope(`${local('clear')} ${envelope('fb', 'fix the dialog')}`)?.prompt).toBe(
      'fix the dialog',
    );
  });

  it('does not read a distant caveat as marking the envelope local', () => {
    const summary = `This session is being continued. ${local('clear')}\n\n…summary…\n\n${envelope('task', 'ship it')}`;
    expect(parseCommandEnvelope(summary)?.command).toBe('task');
  });
});

describe('attributeSteps', () => {
  const steps: CommandStep[] = [
    { id: '0', order: 0, title: 'Incorporate added commands' },
    { id: '1', order: 1, title: 'Set up the workspace' },
    { id: '2', order: 2, title: 'Implement the task' },
    { id: '3', order: 3, title: 'Clean, then PR' },
  ];

  /** Every anchor form the real `/task` transcripts actually contain. */
  it.each([
    ['Step 1 — creating the worktree', '1'],
    ['Step 1.5 — bootstrapping', undefined],
    ['Now Step 3 — clean, then PR.', '3'],
    ['Now step 2, the PR.', '2'],
    ["I'll start with Step 1 — the workspace.", '1'],
    ['`/task` Step 0 — resolving the added commands.', '0'],
    ['Running /god from Step 1.', '1'],
    ['Step 3 — waiting on CI.', '3'],
  ])('anchors on %j', (text, expected) => {
    const [first] = attributeSteps([decision(0, text)], steps);
    if (expected === undefined) return; // 1.5 is not in this catalogue — covered below
    expect(first).toMatchObject({ step: expected, anchor: true });
  });

  /** The phrases that would wreck a looser matcher. All of them lack a step number. */
  it.each([
    'Installing dependencies as its own step',
    'The obvious next step is to verify',
    'Now teardown, then the merge steps',
    "I'll start with the changelog step",
  ])('does not anchor on %j', (text) => {
    expect(attributeSteps([decision(0, text)], steps)[0]).toMatchObject({ step: null, anchor: false });
  });

  it('ignores a number that names no declared step', () => {
    expect(attributeSteps([decision(0, 'Step 9 — off the end')], steps)[0]?.step).toBeNull();
  });

  it('prefers an explicit STEP n/N marker, the successor this heuristic makes room for', () => {
    const marked = attributeSteps([decision(0, 'Wrapping up per step 1 notes. STEP 3/3')], steps)[0];
    expect(marked).toMatchObject({ step: '3', confidence: 'explicit' });
  });

  it('grades a mid-sentence mention lower than an opener', () => {
    const opener = attributeSteps([decision(0, 'Step 2 — implementing')], steps)[0];
    const aside = attributeSteps(
      [decision(0, "Everything above is verified and committed and pushed already, per /task's Step 2 rules")],
      steps,
    )[0];
    expect(opener?.confidence).toBe('explicit');
    expect(aside?.confidence).toBe('narrated');
    expect(aside?.step).toBe('2');
  });

  it('fills forward from an anchor until the next one', () => {
    const attributions = attributeSteps(
      [
        decision(0, 'Step 1 — creating the worktree'),
        tool(1, 'Bash(command=git worktree add)'),
        tool(2, 'Read(file_path=/a.ts)'),
        decision(3, 'Step 2 — implementing'),
        tool(4, 'Edit(file_path=/a.ts)'),
      ],
      steps,
    );
    expect(attributions.map((a) => a.step)).toEqual(['1', '1', '1', '2', '2']);
    expect(attributions.map((a) => a.confidence)).toEqual(['explicit', 'inferred', 'inferred', 'explicit', 'inferred']);
    expect(attributions.filter((a) => a.anchor).map((a) => a.node)).toEqual([0, 3]);
  });

  it('leaves everything before the first anchor in the unattributed bucket', () => {
    const attributions = attributeSteps(
      [node(0, 'task', 'Build the page'), tool(1, 'Read(file_path=/a.ts)'), decision(2, 'Step 2 — implementing')],
      steps,
    );
    expect(attributions.map((a) => a.step)).toEqual([null, null, '2']);
    expect(attributions[0]?.confidence).toBeNull();
  });

  it('attributes nothing when the run never narrates', () => {
    const attributions = attributeSteps([decision(0, 'Looking around'), tool(1, 'Read(file_path=/a.ts)')], steps);
    expect(attributions.every((a) => a.step === null)).toBe(true);
  });

  it('attributes nothing when the command declares no steps', () => {
    const attributions = attributeSteps([decision(0, 'Step 1 — go')], []);
    expect(attributions[0]?.step).toBeNull();
  });

  /** The catalogue as `parseCommandSteps` really builds it for `/task`. */
  const withArtifacts: CommandStep[] = [
    {
      id: '1',
      order: 1,
      title: 'Set up the workspace',
      artifacts: [
        { kind: 'shell', value: 'my-command-tools worktree begin' },
        { kind: 'tool', value: 'EnterWorktree' },
      ],
    },
    {
      id: '2',
      order: 2,
      title: 'Implement the task',
      artifacts: [
        { kind: 'shell', value: 'worktree begin' }, // named only in passing here
        { kind: 'shell', value: 'my-command-tools verify' },
      ],
    },
    {
      id: '3',
      order: 3,
      title: 'Clean, then PR',
      artifacts: [
        { kind: 'skill', value: 'clean' },
        { kind: 'skill', value: 'pr' },
      ],
    },
  ];

  it('anchors on a sub-command the step prescribes', () => {
    const attributions = attributeSteps(
      [decision(0, 'Wrapping up'), tool(1, 'Skill(skill=clean)'), tool(2, 'Bash(command=git status)')],
      withArtifacts,
    );
    expect(attributions[1]).toMatchObject({ step: '3', confidence: 'boundary', anchor: true });
    expect(attributions[2]).toMatchObject({ step: '3', confidence: 'inferred' });
  });

  it('anchors on a prescribed shell invocation and a prescribed tool', () => {
    const at = attributeSteps(
      [
        tool(0, 'Bash(command=my-command-tools worktree begin --branch feat/x --bootstrap)'),
        tool(1, 'EnterWorktree(path=/w)'),
        tool(2, 'Bash(command=my-command-tools verify)'),
      ],
      withArtifacts,
    );
    expect(at.map((a) => a.step)).toEqual(['1', '1', '2']);
    expect(at.every((a) => a.confidence === 'boundary')).toBe(true);
  });

  // Step 2 mentions `worktree begin`; step 1 spells the whole invocation out.
  it('lets the longest matching artifact win an overlap', () => {
    const at = attributeSteps([tool(0, 'Bash(command=my-command-tools worktree begin --branch x)')], withArtifacts);
    expect(at[0]?.step).toBe('1');
  });

  it('ignores an artifact two steps share equally', () => {
    const ambiguous: CommandStep[] = [
      { id: '1', order: 1, title: 'Early', artifacts: [{ kind: 'skill', value: 'clean' }] },
      { id: '2', order: 2, title: 'Late', artifacts: [{ kind: 'skill', value: 'clean' }] },
    ];
    expect(attributeSteps([tool(0, 'Skill(skill=clean)')], ambiguous)[0]?.step).toBeNull();
  });

  it('does not match a skill artifact against an unrelated call', () => {
    expect(attributeSteps([tool(0, 'Bash(command=git clean -fd)')], withArtifacts)[0]?.step).toBeNull();
  });

  it('does not read narration out of a tool call, or a boundary out of prose', () => {
    // A grep *for* the string "Step 2" is not the agent entering step 2.
    expect(attributeSteps([tool(0, "Bash(command=rg 'Step 2' docs)")], steps)[0]?.step).toBeNull();
    expect(attributeSteps([decision(0, "Skill(skill=clean) is what I'd run")], steps)[0]?.step).toBeNull();
  });

  it('records a re-entered step rather than forcing progress forward', () => {
    const attributions = attributeSteps(
      [decision(0, 'Step 2 — implementing'), decision(1, 'Step 3 — PR'), decision(2, 'Step 2 — back to fix a test')],
      steps,
    );
    expect(attributions.map((a) => a.step)).toEqual(['2', '3', '2']);
  });
});

describe('reachedEnd / classifyOutcome', () => {
  const steps: CommandStep[] = [
    { id: '1', order: 1, title: 'Set up' },
    { id: '2', order: 2, title: 'Ship' },
  ];

  it('needs the last declared step and a done line', () => {
    const nodes = [decision(0, 'Step 2 — shipping'), node(1, 'done', 'PR #92 opened')];
    expect(reachedEnd(steps, attributeSteps(nodes, steps), nodes)).toBe(true);
  });

  it('is false when the last step was never reached', () => {
    const nodes = [decision(0, 'Step 1 — setting up'), node(1, 'done', 'stopped early')];
    expect(reachedEnd(steps, attributeSteps(nodes, steps), nodes)).toBe(false);
  });

  it('is false without a done line, however far it got', () => {
    const nodes = [decision(0, 'Step 2 — shipping')];
    expect(reachedEnd(steps, attributeSteps(nodes, steps), nodes)).toBe(false);
  });

  it('judges a stepless command on its done line alone', () => {
    const nodes = [node(0, 'done', 'cleaned')];
    expect(reachedEnd([], attributeSteps(nodes, []), nodes)).toBe(true);
  });

  it('classifies by interruption kind, then error, then activity', () => {
    const base = { reachedEnd: false, interruption: null, lastNodeType: null, active: false } as const;
    expect(classifyOutcome({ ...base, reachedEnd: true })).toBe('completed');
    expect(classifyOutcome({ ...base, interruption: 'limit' })).toBe('interrupted');
    expect(classifyOutcome({ ...base, active: true })).toBe('running');
    expect(classifyOutcome({ ...base, lastNodeType: 'error' })).toBe('errored');
    expect(classifyOutcome({ ...base, lastNodeType: 'tool' })).toBe('interrupted');
    // A completed run stays completed even if it was interrupted along the way.
    expect(classifyOutcome({ ...base, reachedEnd: true, interruption: 'user' })).toBe('completed');
  });
});

describe('countWaste', () => {
  const steps: CommandStep[] = [{ id: '1', order: 1, title: 'Go' }];

  it('counts errors, duplicate reads, retries and no-op turns against their step', () => {
    const nodes = [
      decision(0, 'Step 1 — go'),
      tool(1, 'Read(file_path=/a.ts)'),
      tool(2, 'Read(file_path=/a.ts)'),
      node(3, 'error', 'Bash(command=pnpm test)', 'Bash(command=pnpm test)'),
      tool(4, 'Bash(command=pnpm test)'),
      decision(5, 'Thinking'),
      decision(6, 'Still thinking'),
    ];
    const waste = countWaste(nodes, attributeSteps(nodes, steps)).get('1')!;
    expect(waste).toMatchObject({
      erroredTools: 1,
      duplicateReads: 1,
      retriedAfterError: 1,
      noOpTurns: 2, // node 5 leads to more narration; node 6 ends the run
    });
  });

  it('does not call a differently-shaped follow-up a retry', () => {
    const nodes = [
      decision(0, 'Step 1 — go'),
      node(1, 'error', 'Bash(command=pnpm test)', 'Bash(command=pnpm test)'),
      tool(2, 'Bash(command=pnpm test --run)'),
    ];
    expect(countWaste(nodes, attributeSteps(nodes, steps)).get('1')?.retriedAfterError ?? 0).toBe(0);
  });

  it('charges waste before the first anchor to the unattributed bucket', () => {
    const nodes = [tool(0, 'Read(file_path=/a.ts)'), tool(1, 'Read(file_path=/a.ts)')];
    expect(countWaste(nodes, attributeSteps(nodes, steps)).get(null)?.duplicateReads).toBe(1);
  });
});

describe('detectPatterns', () => {
  const steps: CommandStep[] = [
    { id: '1', order: 1, title: 'Set up' },
    { id: '2', order: 2, title: 'Ship' },
  ];

  it('is deterministic and badges each finding on its node', () => {
    const nodes = [decision(0, 'Step 1 — go'), tool(1, 'Read(file_path=/a.ts)'), tool(2, 'Read(file_path=/a.ts)')];
    const attributions = attributeSteps(nodes, steps);
    const once = detectPatterns(nodes, attributions);
    expect(once).toEqual(detectPatterns(nodes, attributions));
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({ id: 'repeat-read', node: 2, step: '1' });
  });

  it('fires the fan-out rule at the threshold, once', () => {
    const nodes = [
      decision(0, 'Step 2 — shipping'),
      tool(1, 'Agent(subagent_type=Explore)'),
      tool(2, 'Agent(subagent_type=Explore)'),
      tool(3, 'Agent(subagent_type=Explore)'),
      tool(4, 'Agent(subagent_type=Explore)'),
    ];
    const fired = detectPatterns(nodes, attributeSteps(nodes, steps)).filter((p) => p.id === 'subagent-fanout');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.node).toBe(3);
  });

  it('fires on a step re-entered after moving on', () => {
    const nodes = [decision(0, 'Step 1 — go'), decision(1, 'Step 2 — ship'), decision(2, 'Step 1 — back')];
    const fired = detectPatterns(nodes, attributeSteps(nodes, steps));
    expect(fired.map((p) => p.id)).toContain('step-reentered');
  });

  it("fires when a step's first act is an error", () => {
    const nodes = [
      decision(0, 'Step 2 — shipping'),
      node(1, 'error', 'Bash(command=gh pr create)', 'Bash(command=gh pr create)'),
    ];
    const fired = detectPatterns(nodes, attributeSteps(nodes, steps));
    expect(fired.map((p) => p.id)).toEqual(['step-errors-first']);
  });

  it('fires a context re-send spike only on a real jump above the noise floor', () => {
    const nodes = [decision(0, 'Step 1 — go'), tool(1, 'Read(file_path=/a.ts)')];
    const attributions = attributeSteps(nodes, steps);
    const spiked = detectPatterns(nodes, attributions, [
      { step: '1', realInput: 30_000, index: 0, node: 0 },
      { step: '1', realInput: 90_000, index: 1, node: 1 },
    ]);
    expect(spiked.map((p) => p.id)).toEqual(['context-respike']);

    const small = detectPatterns(nodes, attributions, [
      { step: '1', realInput: 200, index: 0, node: 0 },
      { step: '1', realInput: 900, index: 1, node: 1 },
    ]);
    expect(small).toEqual([]);
  });

  it('finds nothing in a clean run', () => {
    const nodes = [decision(0, 'Step 1 — go'), tool(1, 'Read(file_path=/a.ts)'), node(2, 'done', 'shipped')];
    expect(detectPatterns(nodes, attributeSteps(nodes, steps))).toEqual([]);
  });
});

// --- Nested runs -----------------------------------------------------------

describe('findNestedInvocations', () => {
  const installed = (name: string) => ['clean', 'pr', 'review'].includes(name);

  it('reads the command off a Skill call, but only for an installed one', () => {
    expect(nestedCommandOf(tool(0, 'Skill(skill=clean)'), installed)).toBe('clean');
    expect(nestedCommandOf(tool(0, 'Skill(skill=/pr)'), installed)).toBe('pr');
    expect(nestedCommandOf(tool(0, 'Skill(skill=grilling)'), installed)).toBe(null);
    expect(nestedCommandOf(tool(0, 'Bash(command=git status)'), installed)).toBe(null);
    expect(nestedCommandOf(decision(0, 'running Skill(skill=clean) next'), installed)).toBe(null);
  });

  it('splits a /task tail into one span per nested command', () => {
    const nodes = [
      decision(0, 'Step 2 — implement'),
      tool(1, 'Edit(file_path=/a.ts)'),
      tool(2, 'Skill(skill=clean)'),
      tool(3, 'Bash(command=git diff)'),
      tool(4, 'Skill(skill=pr)'),
      tool(5, 'Bash(command=git push)'),
      node(6, 'done', 'shipped'),
    ];
    expect(findNestedInvocations(nodes, installed)).toEqual([
      { command: 'clean', from: 2, to: 4 },
      { command: 'pr', from: 4, to: 7 },
    ]);
  });

  it('finds nothing in a run that invokes no command', () => {
    const nodes = [tool(0, 'Skill(skill=grilling)'), node(1, 'done', 'shipped')];
    expect(findNestedInvocations(nodes, installed)).toEqual([]);
    expect(findNestedInvocations([], installed)).toEqual([]);
  });
});

describe('runKey', () => {
  it('keys a nested run apart from the host it shares a thread with', () => {
    const host = run();
    const nested = run({ runId: nestedRunId(host.threadId, 4), parentRunId: host.threadId, command: 'clean' });
    expect(runKey(nested)).not.toBe(runKey(host));
    expect(nestedRunId(host.threadId, 4)).toBe(`${host.threadId}~4`);
  });

  it('falls back to the thread id a record written before nested runs was keyed by', () => {
    const { runId: _dropped, ...legacy } = run();
    expect(runKey(legacy as CommandRun)).toBe('0000000000000001');
  });
});

// --- Store-level aggregation ----------------------------------------------

function run(over: Partial<CommandRun> = {}): CommandRun {
  return {
    schema: COMMAND_RUN_SCHEMA,
    runId: '0000000000000001',
    parentRunId: null,
    parentCommand: null,
    spawnNode: null,
    nodeRange: null,
    threadId: '0000000000000001',
    command: 'task',
    args: '',
    flags: [],
    prompt: '',
    commandHash: 'abc',
    steps: [],
    model: 'claude-opus-5',
    started: '2026-08-01T10:00:00.000Z',
    ended: '2026-08-01T11:00:00.000Z',
    threadIds: ['0000000000000001'],
    totals: {
      tokens: { ...ZERO_TOKENS, realInput: 100 },
      cost: 1,
      turns: 2,
      toolCalls: 3,
      durationMs: 1000,
      wallMs: 5000,
    },
    turns: [],
    stepStats: [],
    outcome: 'completed',
    interruption: null,
    reachedEnd: true,
    patterns: [],
    meta: { turnsUnmapped: 0, nodes: 0, attributed: 0, anchored: 0 },
    updatedAt: '2026-08-01T11:00:00.000Z',
    ...over,
  };
}

describe('schema tolerance', () => {
  it('accepts a record from a newer or older writer', () => {
    expect(isCommandRun({ schema: 99, threadId: 'a', command: 'task' })).toBe(true);
    expect(isCommandRun({ schema: 0, threadId: 'a', command: 'task' })).toBe(true);
  });

  it('rejects anything without the identity fields', () => {
    expect(isCommandRun(null)).toBe(false);
    expect(isCommandRun('{}')).toBe(false);
    expect(isCommandRun({ threadId: 'a' })).toBe(false);
    expect(isCommandRun({ schema: 1, command: 'task' })).toBe(false);
  });

  it('reads totals off a record that predates the block, rather than throwing', () => {
    const old = { schema: 1, threadId: 'a', command: 'task' } as unknown as CommandRun;
    expect(runTotals(old)).toEqual({
      tokens: ZERO_TOKENS,
      cost: 0,
      turns: 0,
      toolCalls: 0,
      durationMs: 0,
      wallMs: 0,
    });
    expect(() => summarizeCommands([], [old])).not.toThrow();
    expect(() => patternFrequency([old])).not.toThrow();
    expect(() => stepReach([{ id: '1', order: 1, title: 'Go' }], [old])).not.toThrow();
    expect(() => filterRunsByFlags([old], ['sub'])).not.toThrow();
    expect(() => commandRunShapes([old])).not.toThrow();
  });
});

describe('commandRunShapes', () => {
  const steps = [
    { id: '1', order: 1, title: 'One' },
    { id: '2', order: 2, title: 'Two' },
    { id: '3', order: 3, title: 'Three' },
  ];

  /** A step row as `summarizeSteps` writes it, trimmed to what the shape reads. */
  const stat = (step: string | null, reached: boolean) =>
    ({
      step,
      title: '',
      reached,
      confidence: null,
      tokens: ZERO_TOKENS,
      cost: 0,
      turns: 0,
      nodes: 0,
      toolCalls: 0,
      waste: { ...ZERO_WASTE },
    }) as CommandRunStepStats;

  it('counts declared steps reached, and never the unattributed bucket', () => {
    const shapes = commandRunShapes([
      run({
        steps,
        // The unattributed row is reached in every real run; it is not a step.
        stepStats: [stat('1', true), stat('2', true), stat('3', false), stat(null, true)],
      }),
    ]);
    expect(shapes[0]).toMatchObject({ stepsReached: 2, stepsDeclared: 3 });
  });

  it('counts against the run’s own snapshot, so a step added later is not a regression', () => {
    // A step the command file grew afterwards was never available to reach.
    const shapes = commandRunShapes([run({ steps: [steps[0]!], stepStats: [stat('1', true), stat('9', true)] })]);
    expect(shapes[0]).toMatchObject({ stepsReached: 1, stepsDeclared: 1 });
  });

  it('prefers the end-to-end bracket and says so', () => {
    const shapes = commandRunShapes([run()]);
    expect(shapes[0]).toMatchObject({ endToEndMs: 5000, wallMeasured: true });
  });

  it('falls back to the request span for a record written before wallMs, and flags it', () => {
    const old = run();
    // Deleted rather than `undefined`: an older store line has no such key at all.
    delete (old.totals as { wallMs?: number }).wallMs;
    const shapes = commandRunShapes([old]);
    expect(shapes[0]).toMatchObject({ endToEndMs: 1000, wallMeasured: false });
  });

  it('orders oldest first, opposite the run list', () => {
    const shapes = commandRunShapes([
      run({ runId: 'b', started: '2026-08-02T10:00:00.000Z' }),
      run({ runId: 'a', started: '2026-08-01T10:00:00.000Z' }),
    ]);
    expect(shapes.map((s) => s.runId)).toEqual(['a', 'b']);
  });

  it('drops a run with no start, which has nowhere to sit on the axis', () => {
    expect(commandRunShapes([run({ started: null })])).toEqual([]);
  });

  it('reads work off the record rather than recomputing it', () => {
    const shapes = commandRunShapes([run({ meta: { turnsUnmapped: 0, nodes: 42, attributed: 40, anchored: 12 } })]);
    expect(shapes[0]).toMatchObject({ nodes: 42, toolCalls: 3, turns: 2 });
  });
});

describe('summarizeCommands', () => {
  const installed = [{ command: 'task', steps: [{ id: '1', order: 1, title: 'Go' }], commandHash: 'live' }];

  it('renders sensibly with an empty store', () => {
    expect(summarizeCommands(installed, [])).toEqual([
      expect.objectContaining({ command: 'task', runs: 0, completionRate: 0, installed: true, lastRun: null }),
    ]);
  });

  it('counts completion over settled runs only, so a live run does not read as a failure', () => {
    const rows = summarizeCommands(installed, [
      run({ threadId: 'a', reachedEnd: true, outcome: 'completed' }),
      run({ threadId: 'b', reachedEnd: false, outcome: 'interrupted' }),
      run({ threadId: 'c', reachedEnd: false, outcome: 'running' }),
    ]);
    expect(rows[0]).toMatchObject({ runs: 3, completionRate: 0.5 });
  });

  it('keeps a command the store has runs for but that is no longer installed', () => {
    const rows = summarizeCommands(installed, [run({ command: 'retired' })]);
    expect(rows.map((r) => [r.command, r.installed])).toEqual(
      expect.arrayContaining([
        ['task', true],
        ['retired', false],
      ]),
    );
  });

  it('collects the flags seen across runs for the facet', () => {
    const rows = summarizeCommands(installed, [
      run({ threadId: 'a', flags: ['sub'] }),
      run({ threadId: 'b', flags: ['draft', 'sub'] }),
    ]);
    expect(rows[0]?.flags).toEqual(['draft', 'sub']);
  });

  it('orders the cost sparkline oldest first', () => {
    const rows = summarizeCommands(installed, [
      run({ threadId: 'b', started: '2026-08-02T10:00:00.000Z', totals: { ...run().totals, cost: 2 } }),
      run({ threadId: 'a', started: '2026-08-01T10:00:00.000Z', totals: { ...run().totals, cost: 1 } }),
    ]);
    expect(rows[0]?.costSeries.map((p) => p.value)).toEqual([1, 2]);
    expect(rows[0]?.lastRun).toBe('2026-08-02T10:00:00.000Z');
  });
});

describe('stepReach', () => {
  const steps: CommandStep[] = [
    { id: '1', order: 1, title: 'Set up' },
    { id: '2', order: 2, title: 'Ship' },
  ];

  it('keeps unreached steps in the funnel and appends the unattributed bucket', () => {
    const stats = (reached: boolean) => [
      {
        step: '1',
        title: '',
        reached: true,
        confidence: null,
        tokens: ZERO_TOKENS,
        cost: 0,
        turns: 0,
        nodes: 0,
        toolCalls: 0,
        waste: { erroredTools: 0, duplicateReads: 0, retriedAfterError: 0, noOpTurns: 0, cacheMissTokens: 0 },
      },
      {
        step: '2',
        title: '',
        reached,
        confidence: null,
        tokens: ZERO_TOKENS,
        cost: 0,
        turns: 0,
        nodes: 0,
        toolCalls: 0,
        waste: { erroredTools: 0, duplicateReads: 0, retriedAfterError: 0, noOpTurns: 0, cacheMissTokens: 0 },
      },
    ];
    const funnel = stepReach(steps, [run({ stepStats: stats(true) }), run({ threadId: 'b', stepStats: stats(false) })]);
    expect(funnel.map((s) => [s.step, s.reached, s.ofRuns])).toEqual([
      ['1', 2, 2],
      ['2', 1, 2],
      [null, 0, 2],
    ]);
    expect(funnel[2]?.title).toBe('Unattributed');
  });
});

describe('patternFrequency', () => {
  it('counts runs a rule fired in, and lists rules that never fired', () => {
    const hit = { id: 'repeat-read' as const, title: '', detail: '', step: '1', node: 2 };
    const freq = patternFrequency([
      run({ threadId: 'a', patterns: [hit, { ...hit, node: 3 }] }),
      run({ threadId: 'b', patterns: [] }),
    ]);
    expect(freq[0]).toMatchObject({ id: 'repeat-read', runs: 1, ofRuns: 2, hits: 2 });
    expect(freq).toHaveLength(6);
    expect(freq.filter((f) => f.runs === 0)).toHaveLength(5);
  });
});

describe('filterRunsByFlags', () => {
  const runs = [
    run({ threadId: 'a', flags: ['sub'] }),
    run({ threadId: 'b', flags: [] }),
    run({ threadId: 'c', flags: ['sub', 'draft'] }),
  ];

  it('keeps everything when nothing is selected', () => {
    expect(filterRunsByFlags(runs, [])).toHaveLength(3);
  });

  it('requires every selected flag', () => {
    expect(filterRunsByFlags(runs, ['sub']).map((r) => r.threadId)).toEqual(['a', 'c']);
    expect(filterRunsByFlags(runs, ['sub', 'draft']).map((r) => r.threadId)).toEqual(['c']);
  });
});

describe('summarizeSteps', () => {
  const steps: CommandStep[] = [
    { id: '1', order: 1, title: 'Set up' },
    { id: '2', order: 2, title: 'Ship' },
  ];

  it('splits tokens by step and keeps the unattributed bucket visible', () => {
    const nodes = [
      tool(0, 'Read(file_path=/a.ts)'),
      decision(1, 'Step 1 — go'),
      tool(2, 'Bash(command=pnpm i)'),
      decision(3, 'Step 2 — ship'),
    ];
    const turn = (step: string | null, realInput: number, output: number) => ({
      file: 'f',
      timestamp: '2026-08-01T10:00:00.000Z',
      threadId: 't',
      step,
      node: null,
      tokens: { input: 0, output, cacheRead: realInput / 2, cacheCreation: 0, realInput },
      systemBytes: 0,
      toolsBytes: 0,
      toolCount: 0,
      messageCount: 0,
    });

    const stats = summarizeSteps({
      steps,
      nodes,
      attributions: attributeSteps(nodes, steps),
      turns: [turn(null, 1000, 10), turn('1', 2000, 20), turn('2', 4000, 40)],
      model: 'claude-opus-5',
    });

    expect(stats.map((s) => s.step)).toEqual(['1', '2', null]);
    expect(stats.map((s) => s.tokens.realInput)).toEqual([2000, 4000, 1000]);
    expect(stats.map((s) => s.nodes)).toEqual([2, 1, 1]);
    expect(stats[2]?.title).toBe('Unattributed');
    // realInput − cacheRead, per the turn's own split.
    expect(stats[0]?.waste.cacheMissTokens).toBe(1000);
    expect(stats[0]?.cost).toBeGreaterThan(0);
    expect(stats.map((s) => s.confidence)).toEqual(['explicit', 'explicit', null]);
  });

  it('lists an unreached step at zero rather than dropping it', () => {
    const nodes = [decision(0, 'Step 1 — go')];
    const stats = summarizeSteps({
      steps,
      nodes,
      attributions: attributeSteps(nodes, steps),
      turns: [],
      model: 'claude-opus-5',
    });
    expect(stats[1]).toMatchObject({ step: '2', reached: false, turns: 0, cost: 0 });
  });
});
