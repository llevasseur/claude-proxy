import { describe, expect, it } from 'vitest';
import {
  buildPrTree,
  matchPrInText,
  type PullRequestRow,
  parsePullRequests,
  parseRepoSlug,
  prCounts,
} from '../src/pull-requests.js';

/** A row with everything filled in, so a test only states the fields it cares about. */
const row = (over: Partial<PullRequestRow> & { number: number }): PullRequestRow => ({
  title: `pr ${over.number}`,
  author: 'llevasseur',
  state: 'merged',
  isDraft: false,
  url: `https://github.com/o/r/pull/${over.number}`,
  baseRefName: 'main',
  headRefName: `feat/pr-${over.number}`,
  body: '',
  labels: [],
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
  mergedAt: null,
  closedAt: null,
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  ...over,
});

describe('parsePullRequests', () => {
  it('reads gh output, newest first', () => {
    const rows = parsePullRequests([
      { number: 1, title: 'first', author: { login: 'ada' }, state: 'MERGED', mergedAt: '2026-08-01T10:00:00Z' },
      { number: 3, title: 'third', author: { login: 'ada' }, state: 'OPEN' },
    ]);

    expect(rows.map((r) => r.number)).toEqual([3, 1]);
    expect(rows[1]).toMatchObject({ title: 'first', author: 'ada', state: 'merged' });
  });

  it('classifies off the merge timestamp when the state field is missing', () => {
    const [merged, closed, open] = parsePullRequests([
      { number: 9, mergedAt: '2026-08-02T00:00:00Z' },
      { number: 8, closedAt: '2026-08-02T00:00:00Z' },
      { number: 7 },
    ]);

    expect([merged?.state, closed?.state, open?.state]).toEqual(['merged', 'closed', 'open']);
  });

  it('degrades a malformed row rather than the whole page', () => {
    // No number is the one thing that cannot degrade — it is the identity.
    expect(parsePullRequests([null, 'nope', { title: 'orphan' }, { number: 0 }])).toEqual([]);

    const [only] = parsePullRequests([{ number: 4, title: 42, author: null, labels: ['bug', { name: 'ui' }, null] }]);
    expect(only).toMatchObject({ title: '', author: '', labels: ['bug', 'ui'], additions: 0 });
  });

  it('is empty for anything that is not a list', () => {
    expect(parsePullRequests({ prs: [] })).toEqual([]);
    expect(parsePullRequests(null)).toEqual([]);
  });
});

describe('buildPrTree', () => {
  const merged1 = row({ number: 1, mergedAt: '2026-08-01T10:00:00Z', createdAt: '2026-08-01T09:00:00Z' });
  const merged2 = row({ number: 2, mergedAt: '2026-08-03T10:00:00Z', createdAt: '2026-08-02T09:00:00Z' });
  const open = row({ number: 5, state: 'open', createdAt: '2026-08-04T09:00:00Z' });
  const early = row({ number: 6, state: 'open', createdAt: '2026-07-01T09:00:00Z' });
  const dead = row({ number: 7, state: 'closed', closedAt: '2026-08-04T00:00:00Z', createdAt: '2026-08-02T00:00:00Z' });

  it('puts merged PRs on the trunk in merge order, whatever order they arrive in', () => {
    expect(buildPrTree([merged2, merged1]).trunk.map((p) => p.number)).toEqual([1, 2]);
  });

  it('hangs a PR off the last merge that had landed when it was opened', () => {
    const tree = buildPrTree([merged1, merged2, open, dead]);

    expect(tree.open).toEqual([{ pr: open, after: 1 }]);
    // Opened after #1 landed but before #2 did.
    expect(tree.closed).toEqual([{ pr: dead, after: 0 }]);
  });

  it('hangs a PR older than every merge off the root', () => {
    expect(buildPrTree([merged1, merged2, early]).open).toEqual([{ pr: early, after: -1 }]);
  });

  it('counts each state, with drafts counted alongside their own state', () => {
    const draft = row({ number: 8, state: 'open', isDraft: true });
    expect(prCounts([merged1, open, dead, draft])).toEqual({ merged: 1, open: 2, closed: 1, draft: 1 });
  });
});

describe('matchPrInText', () => {
  const pr = row({ number: 14, headRefName: 'feat/pr-tree' });

  it('matches a transcript that names the branch, including its worktree spelling', () => {
    expect(matchPrInText(pr, 'switched to feat/pr-tree')).toEqual(['branch']);
    expect(matchPrInText(pr, '.claude/worktrees/feat-pr-tree/server')).toEqual(['branch']);
  });

  it('matches the number as a qualified #ref or a pull url, and both signals at once', () => {
    expect(matchPrInText(pr, 'merged #14')).toEqual(['number']);
    expect(matchPrInText(pr, 'https://github.com/o/r/pull/14')).toEqual(['number']);
    expect(matchPrInText(pr, 'feat/pr-tree is #14')).toEqual(['branch', 'number']);
  });

  it('does not match a longer number that merely starts with this one', () => {
    expect(matchPrInText(pr, 'see PR #144 and /pull/1409')).toEqual([]);
  });

  it('does not match a branch it is only the head of', () => {
    expect(matchPrInText(pr, 'shipped feat/pr-tree-page')).toEqual([]);
    expect(matchPrInText(pr, 'entered .claude/worktrees/feat-pr-tree-page')).toEqual([]);
    // A path under the worktree is still the branch itself.
    expect(matchPrInText(pr, '.claude/worktrees/feat-pr-tree/server/src')).toEqual(['branch']);
  });

  it('ignores a branch name too short to be distinctive', () => {
    expect(matchPrInText(row({ number: 3, headRefName: 'wip' }), 'wip wip wip')).toEqual([]);
  });

  it('will not read an unqualified #n as a PR reference, but still reads its url', () => {
    // Both of these matched before the context rule: #1 tied four unrelated sessions
    // to the repo's first PR, and "message #10" tied one to PR 10.
    const low = row({ number: 1, headRefName: 'feat/first' });
    expect(matchPrInText(low, 'step #1 of the plan')).toEqual([]);
    expect(matchPrInText(low, 'https://github.com/o/r/pull/1')).toEqual(['number']);
    expect(matchPrInText(row({ number: 10, headRefName: 'feat/tenth' }), 'why is message #10 output')).toEqual([]);
  });
});

describe('parseRepoSlug', () => {
  it('reads both remote spellings', () => {
    expect(parseRepoSlug('git@github.com:llevasseur/claude-proxy.git\n')).toBe('llevasseur/claude-proxy');
    expect(parseRepoSlug('https://github.com/llevasseur/claude-proxy')).toBe('llevasseur/claude-proxy');
  });

  it('is null for a remote that is not GitHub', () => {
    expect(parseRepoSlug('git@gitlab.com:o/r.git')).toBeNull();
    expect(parseRepoSlug('')).toBeNull();
  });
});
