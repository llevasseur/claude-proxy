// The PR→session link is recovered from transcript text, so these cases are written as
// transcripts on disk rather than as calls into the matcher.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PullRequestRow } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import { readPrSessions } from '../src/pr-sessions.js';

const pr = (over: Partial<PullRequestRow> & { number: number }): PullRequestRow => ({
  title: `pr ${over.number}`,
  author: 'llevasseur',
  state: 'open',
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

const THREADS = ['0123456789abcdef', 'fedcba9876543210', 'abcdefabcdef0123'];

/** A log directory holding `<thread>.md` transcripts with the given bodies. */
async function logDirWith(transcripts: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'pr-sessions-'));
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  for (const [id, body] of Object.entries(transcripts)) {
    await writeFile(path.join(root, 'sessions', `${id}.md`), `# session\n\n${body}\n`, 'utf8');
  }
  return root;
}

describe('readPrSessions', () => {
  it('links a transcript by branch name, by number, and by both at once', async () => {
    const [built, reviewed, both] = THREADS as [string, string, string];
    const dir = await logDirWith({
      [built]: 'working in .claude/worktrees/feat-pr-tree on the page',
      [reviewed]: 'merged PR #14 after review',
      [both]: 'feat/pr-tree is up as pull #14',
    });

    const index = await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-tree' })]);

    const links = index[14] ?? [];
    expect(links.map((l) => l.threadId).sort()).toEqual([built, reviewed, both].sort());
    expect(links.find((l) => l.threadId === built)?.via).toEqual(['branch']);
    expect(links.find((l) => l.threadId === reviewed)?.via).toEqual(['number']);
    expect(links.find((l) => l.threadId === both)?.via).toEqual(['branch', 'number']);
  });

  it('does not link a branch that is merely the head of a longer one', async () => {
    const [only] = THREADS as [string, ...string[]];
    const dir = await logDirWith({ [only]: 'shipped on feat/pr-tree-page today' });

    const index = await readPrSessions(dir, [
      pr({ number: 14, headRefName: 'feat/pr-tree' }),
      pr({ number: 15, headRefName: 'feat/pr-tree-page' }),
    ]);

    expect(index[14]).toBeUndefined();
    expect(index[15]?.map((l) => l.threadId)).toEqual([only]);
  });

  it('ignores files that are not transcripts, and a missing sessions directory', async () => {
    const [only] = THREADS as [string, ...string[]];
    const dir = await logDirWith({ [only]: 'nothing to see' });
    await writeFile(path.join(dir, 'sessions', 'notes.md'), 'merged PR #14', 'utf8');

    expect(await readPrSessions(dir, [pr({ number: 14 })])).toEqual({});
    expect(await readPrSessions(path.join(dir, 'nope'), [pr({ number: 14 })])).toEqual({});
  });

  it('is an empty index when there are no pull requests to match', async () => {
    const [only] = THREADS as [string, ...string[]];
    const dir = await logDirWith({ [only]: 'merged PR #14' });
    expect(await readPrSessions(dir, [])).toEqual({});
  });

  it('reuses a cached index under the same key, and rebuilds under a new one', async () => {
    const [first, second] = THREADS as [string, string, ...string[]];
    const dir = await logDirWith({ [first]: 'merged PR #14' });
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    const before = await readPrSessions(dir, prs, `${dir}:one`);
    expect(before[14]?.map((l) => l.threadId)).toEqual([first]);

    await writeFile(path.join(dir, 'sessions', `${second}.md`), '# session\n\nmerged PR #14\n', 'utf8');

    const cached = await readPrSessions(dir, prs, `${dir}:one`);
    expect(cached[14]?.map((l) => l.threadId)).toEqual([first]);

    const fresh = await readPrSessions(dir, prs, `${dir}:two`);
    expect(fresh[14]?.map((l) => l.threadId).sort()).toEqual([first, second].sort());
  });
});
