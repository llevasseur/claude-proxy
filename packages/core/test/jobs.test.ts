import { describe, expect, it } from 'vitest';
import {
  buildJobTree,
  jobFileKind,
  jobStateTone,
  normalizeJobState,
  parseJobTimeline,
  type JobFileEntry,
} from '../src/jobs.js';

describe('normalizeJobState', () => {
  it('shapes a real state.json, pulling the model out of respawnFlags', () => {
    const state = normalizeJobState({
      state: 'done',
      detail: 'shipped it',
      tempo: 'active',
      intent: '/fb fix the thing',
      name: 'admin chart styling',
      nameSource: 'auto',
      tokens: 116339,
      template: 'claude',
      respawnFlags: ['--agent', 'claude', '--model', 'opus[1m]'],
      cwd: '/Users/me/app',
      sessionId: '78129130-d6b6-446b-9b8b-6aa828ab0630',
      backend: 'daemon',
      cliVersion: '2.1.220',
      createdAt: '2026-07-28T15:03:01.821Z',
      updatedAt: '2026-07-28T17:31:11.279Z',
      firstTerminalAt: '2026-07-28T15:40:05.965Z',
      children: [{ id: '1020', href: 'https://github.com/o/r/pull/1020', kind: 'pr' }],
      inFlight: { tasks: 1, queued: 0, kinds: ['local_bash'] },
      fan: [{ id: 'bsjg37vzh', kind: 'shell', label: 'pnpm storybook', startedAt: 1785259829035 }],
    });

    expect(state.state).toBe('done');
    expect(state.model).toBe('opus[1m]');
    expect(state.agent).toBe('claude');
    expect(state.tokens).toBe(116339);
    expect(state.children).toEqual([{ id: '1020', kind: 'pr', href: 'https://github.com/o/r/pull/1020' }]);
    expect(state.inFlight).toEqual({ tasks: 1, queued: 0, kinds: ['local_bash'] });
    expect(state.fan).toEqual([
      { id: 'bsjg37vzh', kind: 'shell', label: 'pnpm storybook', startedAt: '2026-07-28T17:30:29.035Z' },
    ]);
  });

  it('falls back to originCwd when cwd is absent', () => {
    expect(normalizeJobState({ originCwd: '/Users/me/app' }).cwd).toBe('/Users/me/app');
  });

  it('yields all-empty fields for a missing or malformed file', () => {
    for (const input of [null, undefined, 'nope', 42, []]) {
      const state = normalizeJobState(input);
      expect(state.state).toBe('');
      expect(state.tokens).toBeNull();
      expect(state.children).toEqual([]);
      expect(state.fan).toEqual([]);
      expect(state.inFlight).toBeNull();
    }
  });

  it('skips a child with no href and a fan task with an unusable start', () => {
    const state = normalizeJobState({
      children: [
        { id: '1', kind: 'pr' },
        { id: '2', kind: 'pr', href: 'https://x/2' },
      ],
      fan: [{ id: 'a', kind: 'shell', label: 'x', startedAt: 'not-a-number' }],
    });
    expect(state.children).toHaveLength(1);
    expect(state.fan[0]?.startedAt).toBe('');
  });
});

describe('jobStateTone', () => {
  it('classifies the states Claude Code writes', () => {
    expect(jobStateTone('working')).toBe('busy');
    expect(jobStateTone('done')).toBe('done');
    expect(jobStateTone('failed')).toBe('failed');
    expect(jobStateTone('idle')).toBe('idle');
  });

  it('folds case, spaces and underscores before matching', () => {
    expect(jobStateTone('needs_input')).toBe('blocked');
    expect(jobStateTone('Needs Input')).toBe('blocked');
    expect(jobStateTone(' DONE ')).toBe('done');
  });

  it("leaves a state it doesn't know as unknown rather than guessing", () => {
    expect(jobStateTone('recapping')).toBe('unknown');
    expect(jobStateTone('')).toBe('unknown');
  });
});

describe('parseJobTimeline', () => {
  it('parses one record per line, numbering them from 1', () => {
    const content = [
      JSON.stringify({ at: '2026-07-28T15:40:05.965Z', state: 'done', detail: 'shipped', text: 'narration' }),
      JSON.stringify({ at: '2026-07-28T17:28:40.108Z', state: 'done', detail: 'again', text: '' }),
    ].join('\n');
    const { entries, skipped } = parseJobTimeline(content);
    expect(skipped).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      line: 1,
      at: '2026-07-28T15:40:05.965Z',
      state: 'done',
      detail: 'shipped',
      text: 'narration',
    });
    expect(entries[1]?.line).toBe(2);
  });

  it('counts a half-written trailing line instead of throwing', () => {
    const { entries, skipped } = parseJobTimeline(`${JSON.stringify({ state: 'working' })}\n{"state":"do`);
    expect(entries).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it('ignores blank lines', () => {
    expect(parseJobTimeline('\n\n').entries).toEqual([]);
    expect(parseJobTimeline('\n\n').skipped).toBe(0);
  });
});

describe('jobFileKind', () => {
  it('maps the extensions a job directory actually holds', () => {
    expect(jobFileKind('state.json')).toBe('json');
    expect(jobFileKind('timeline.jsonl')).toBe('jsonl');
    expect(jobFileKind('sb.log')).toBe('log');
    expect(jobFileKind('check-stories.mjs')).toBe('code');
    expect(jobFileKind('notes.md')).toBe('markdown');
    expect(jobFileKind('metrics-375.png')).toBe('image');
    expect(jobFileKind('cookies.txt')).toBe('text');
  });

  it('treats an extensionless file as text — the daemon drops bare markers', () => {
    expect(jobFileKind('recap')).toBe('text');
    expect(jobFileKind('.gitkeep')).toBe('text');
  });

  it("assumes binary for an extension it doesn't know", () => {
    expect(jobFileKind('core.dump')).toBe('binary');
    expect(jobFileKind('thing.wasm')).toBe('binary');
  });
});

describe('buildJobTree', () => {
  const file = (path: string, bytes: number): JobFileEntry => ({
    path,
    dir: false,
    bytes,
    modified: '2026-07-28T13:00:00.000Z',
    kind: 'text',
  });
  const dir = (path: string): JobFileEntry => ({
    path,
    dir: true,
    bytes: 0,
    modified: '2026-07-28T13:00:00.000Z',
    kind: null,
  });

  it('nests entries, putting directories before files and each alphabetically', () => {
    const tree = buildJobTree([
      file('state.json', 100),
      dir('tmp'),
      file('timeline.jsonl', 50),
      file('tmp/shots.mjs', 700),
      dir('tmp/node_modules'),
    ]);

    expect(tree.map((n) => n.name)).toEqual(['tmp', 'state.json', 'timeline.jsonl']);
    const tmp = tree[0];
    expect(tmp?.children.map((n) => n.name)).toEqual(['node_modules', 'shots.mjs']);
    expect(tmp?.depth).toBe(0);
    expect(tmp?.children[1]?.depth).toBe(1);
  });

  it('rolls file counts and bytes up through every level', () => {
    const tree = buildJobTree([
      dir('tmp'),
      dir('tmp/deep'),
      file('tmp/deep/a.txt', 10),
      file('tmp/deep/b.txt', 5),
      file('tmp/c.txt', 1),
      file('state.json', 100),
    ]);

    const tmp = tree.find((n) => n.name === 'tmp');
    expect(tmp?.files).toBe(3);
    expect(tmp?.totalBytes).toBe(16);
    expect(tmp?.children.find((n) => n.name === 'deep')?.files).toBe(2);
    expect(tree.find((n) => n.name === 'state.json')?.files).toBe(1);
  });

  it('synthesizes an intermediate directory the walk never listed', () => {
    const tree = buildJobTree([file('tmp/deep/a.txt', 10)]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.name).toBe('tmp');
    expect(tree[0]?.dir).toBe(true);
    expect(tree[0]?.children[0]?.name).toBe('deep');
    expect(tree[0]?.children[0]?.children[0]?.name).toBe('a.txt');
    expect(tree[0]?.files).toBe(1);
  });

  it("keeps the real entry's metadata when a child created its placeholder first", () => {
    const tree = buildJobTree([file('tmp/a.txt', 10), { ...dir('tmp'), skipped: true }]);
    expect(tree[0]?.skipped).toBe(true);
    expect(tree[0]?.modified).toBe('2026-07-28T13:00:00.000Z');
    expect(tree[0]?.children).toHaveLength(1);
  });

  it('returns [] for no entries', () => {
    expect(buildJobTree([])).toEqual([]);
  });
});
