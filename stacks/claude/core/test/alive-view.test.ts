import { describe, expect, it } from 'vitest';
import {
  type AliveView,
  aliveTriggerLine,
  deriveAliveView,
  type FamilyTranscript,
  STRESS_THRESHOLD_MS,
} from '../src/alive-view.js';
import type { SessionNode, SessionNodeType } from '../src/sessions.js';

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
/** An ISO stamp `ms` before {@link NOW}. */
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

let seq = 0;
/** A node fixture — only `type`, `text`, `tool` and `interrupted` matter to the derivation. */
const node = (type: SessionNodeType, over: Partial<SessionNode> = {}): SessionNode => ({
  index: seq++,
  type,
  text: 'whatever',
  tool: null,
  argsHash: null,
  task: null,
  interruption: null,
  interrupted: false,
  message: null,
  turn: null,
  ...over,
});

/** One family transcript whose newest append was `ms` ago, carrying these nodes. */
const thread = (ms: number, nodes: SessionNode[], over: Partial<FamilyTranscript> = {}): FamilyTranscript => ({
  threadId: `t${seq++}`,
  modified: ago(ms),
  nodes,
  ...over,
});

describe('deriveAliveView — node-type mapping', () => {
  const cases: [SessionNodeType, AliveView['emotion']][] = [
    ['task', 'Thinking'],
    ['decision', 'Thinking'],
    ['tool', 'Thinking'],
    ['done', 'Smiling'],
    ['error', 'Disgruntled'],
  ];
  for (const [type, emotion] of cases) {
    it(`maps a last ${type} node to ${emotion}`, () => {
      expect(deriveAliveView([thread(60_000, [node('done'), node(type)])], NOW).emotion).toBe(emotion);
    });
  }
});

describe('deriveAliveView — interruption is terminal (ADR 0023)', () => {
  it('reads an interrupted last node as Smiling whatever the step was', () => {
    for (const type of ['task', 'decision', 'tool', 'error', 'done'] as const) {
      const view = deriveAliveView([thread(60_000, [node(type, { interrupted: true })])], NOW);
      expect(view.emotion).toBe('Smiling');
      expect(view.trigger.startsWith('stopped · ')).toBe(true);
    }
  });

  it('never ages an interrupted run into Stressed', () => {
    const view = deriveAliveView([thread(STRESS_THRESHOLD_MS * 10, [node('task', { interrupted: true })])], NOW);
    expect(view.emotion).toBe('Smiling');
  });
});

describe('deriveAliveView — the stress boundary', () => {
  it('keeps Thinking at exactly the threshold and stresses one millisecond past it', () => {
    const at = deriveAliveView([thread(STRESS_THRESHOLD_MS, [node('tool')])], NOW);
    expect(at.emotion).toBe('Thinking');

    const past = deriveAliveView([thread(STRESS_THRESHOLD_MS + 1, [node('tool')])], NOW);
    expect(past.emotion).toBe('Stressed');
  });

  it('renders the stressed line bare — no step index, no age suffix (ADR 0026)', () => {
    const view = deriveAliveView([thread(STRESS_THRESHOLD_MS + 5 * 60_000, [node('decision')])], NOW);
    expect(view.trigger).toBe('idle for 35m');
  });

  it('never ages a finished or errored run into Stressed', () => {
    const old = STRESS_THRESHOLD_MS * 24;
    expect(deriveAliveView([thread(old, [node('done')])], NOW).emotion).toBe('Smiling');
    expect(deriveAliveView([thread(old, [node('error', { tool: 'Bash(make)' })])], NOW).emotion).toBe('Disgruntled');
  });

  it('reads a family with no nodes as Smiling however stale it is', () => {
    expect(deriveAliveView([thread(STRESS_THRESHOLD_MS * 9, [])], NOW)).toEqual({
      emotion: 'Smiling',
      trigger: '',
    });
  });
});

describe('aliveTriggerLine — per-type leads', () => {
  let step = 0;
  const lineFor = (over: Partial<SessionNode>, ageMs = 120_000): string => {
    const n = node('done', { index: step++, ...over });
    const emotion = n.interrupted || n.type === 'done' ? 'Smiling' : n.type === 'error' ? 'Disgruntled' : 'Thinking';
    return aliveTriggerLine(emotion, n, ageMs);
  };

  it('names the call and its first argument on a tool step', () => {
    expect(lineFor({ type: 'tool', tool: 'Edit(file_path=/a/b.ts, old_string=x)' })).toBe(
      'tool · Edit(file_path=/a/b.ts) · step 0 · 2m ago',
    );
  });

  it('blames the nearest preceding tool on an error (ADR 0024)', () => {
    expect(lineFor({ type: 'error', text: 'exit 1', tool: 'Bash(npm test)' })).toBe(
      'error · Bash(npm test) failed · step 1 · 2m ago',
    );
  });

  it("falls back to the node's own text when an error blames no tool (ADR 0024)", () => {
    expect(lineFor({ type: 'error', text: 'rate limited' })).toBe('error · rate limited · step 2 · 2m ago');
  });

  it('carries the outcome text on a done line, under the general grammar', () => {
    expect(lineFor({ type: 'done', text: 'shipped it' })).toBe('Smiling · shipped it · step 3 · 2m ago');
  });

  it('cuts long text to roughly eighty characters on a word boundary', () => {
    const long = 'word '.repeat(40).trim();
    const line = lineFor({ type: 'decision', text: long });
    expect(line.length).toBeLessThan(long.length);
    expect(line.includes('… · step')).toBe(true);
    expect(line.includes('· step 4 · 2m ago')).toBe(true);
  });

  it('renders the stopped form with the cut-off step’s text (ADR 0023)', () => {
    expect(lineFor({ type: 'tool', interrupted: true, tool: 'Bash(make)', text: 'Bash(make)' })).toBe(
      'stopped · Bash(make) · step 5 · 2m ago',
    );
  });

  it('floors age to whole minutes since the last append, never negative', () => {
    expect(lineFor({ type: 'done', text: 'ok' }, 500)).toBe('Smiling · ok · step 6 · 0m ago');
    expect(lineFor({ type: 'done', text: 'ok' }, -60_000)).toBe('Smiling · ok · step 7 · 0m ago');
  });
});

describe('deriveAliveView — selection and empty inputs', () => {
  it('derives from the newest-modified transcript during a fan-out (ADR 0022)', () => {
    // The parent finished; its branch appended after. The branch describes the family.
    const view = deriveAliveView(
      [
        thread(600_000, [node('done', { text: 'parent handed back' })]),
        thread(30_000, [node('tool', { tool: 'Grep(pattern=alive)' })]),
      ],
      NOW,
    );
    expect(view.emotion).toBe('Thinking');
    expect(view.trigger).toContain('Grep(pattern=alive)');
  });

  it('returns Smiling with an empty trigger for an empty family or undated stamps', () => {
    expect(deriveAliveView([], NOW)).toEqual({ emotion: 'Smiling', trigger: '' });
    expect(deriveAliveView([{ threadId: 't', modified: 'not a date', nodes: [node('tool')] }], NOW)).toEqual({
      emotion: 'Smiling',
      trigger: '',
    });
  });

  it('merges the two raw arrays when the caller has not already done so', () => {
    const view = deriveAliveView(
      [
        {
          threadId: 't',
          modified: ago(60_000),
          // The merged stream keeps the transcript's length: its gisted done line
          // pairs with the request's full-text one, which then supplies the text.
          transcript: [node('task', { text: 'the ask' }), node('done', { text: 'the answer' })],
          derived: [node('task', { text: 'the ask' }), node('done', { text: 'the answer' })],
        },
      ],
      NOW,
    );
    expect(view.emotion).toBe('Smiling');
    expect(view.trigger).toContain('the answer');
  });
});
