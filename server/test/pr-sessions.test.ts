// A session records the pull request it opened, and the transcript scan is the fallback for
// one nothing recorded — so these cases are written as files on disk (transcripts, and the
// `.state.json` sidecars carrying the record) rather than as calls into the matcher.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PullRequestRow } from '@claude-proxy/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestSessions } from '../src/db/ingest-sessions.js';
import { openDb } from '../src/db/open.js';
import { dbSource } from '../src/db/source.js';
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
  mergeCommit: null,
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

/** The `.state.json` sidecar the proxy writes, recording the PR the run opened. */
async function recordPr(logDir: string, threadId: string, url: string): Promise<void> {
  await writeFile(
    path.join(logDir, 'sessions', `${threadId}.state.json`),
    JSON.stringify({ count: 4, started: true, root: 'open a PR', pr: url }),
    'utf8',
  );
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

describe('readPrSessions, on the recorded link', () => {
  let db: DatabaseSync | null = null;
  let dir: string | null = null;

  afterEach(async () => {
    db?.close();
    db = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('answers from the record, and stops scanning the transcripts entirely', async () => {
    const [opener, mentions] = THREADS as [string, string, ...string[]];
    dir = await logDirWith({
      [opener]: 'ran my-command-tools pr and it printed the url',
      // Would match by branch *and* number — and must not appear, because the PR is named.
      [mentions]: 'reviewed feat/pr-tree, merged PR #14',
    });
    await recordPr(dir, opener, 'https://github.com/o/r/pull/14');

    const index = await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-tree' })]);

    expect(index[14]?.map((l) => l.threadId)).toEqual([opener]);
    expect(index[14]?.map((l) => l.via)).toEqual([['recorded']]);
  });

  it('scans only the pull requests no session recorded', async () => {
    const [opener, other] = THREADS as [string, string, ...string[]];
    dir = await logDirWith({ [opener]: 'opened it', [other]: 'shipped feat/pr-15 earlier' });
    await recordPr(dir, opener, 'https://github.com/o/r/pull/14');

    const index = await readPrSessions(dir, [
      pr({ number: 14, headRefName: 'feat/pr-14' }),
      pr({ number: 15, headRefName: 'feat/pr-15' }),
    ]);

    expect(index[14]?.map((l) => l.via)).toEqual([['recorded']]);
    expect(index[15]?.map((l) => l.threadId)).toEqual([other]);
    expect(index[15]?.map((l) => l.via)).toEqual([['branch']]);
  });

  it('does not read a pull request in another repository as this one', async () => {
    const [elsewhere] = THREADS as [string, ...string[]];
    dir = await logDirWith({ [elsewhere]: 'nothing about this repo' });
    await recordPr(dir, elsewhere, 'https://github.com/other/repo/pull/14');

    // Same number, different repository — so #14 here is still unnamed, and the scan that
    // then runs finds nothing in that transcript either.
    expect(await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-14' })])).toEqual({});
  });

  it('drops a recorded link whose transcript has rotated away', async () => {
    const [gone] = THREADS as [string, ...string[]];
    dir = await mkdtemp(path.join(tmpdir(), 'pr-sessions-'));
    await mkdir(path.join(dir, 'sessions'), { recursive: true });
    await recordPr(dir, gone, 'https://github.com/o/r/pull/14');

    expect(await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-14' })])).toEqual({});
  });

  it('answers the same from the substrate as from the sidecars', async () => {
    const [opener, mentions] = THREADS as [string, string, ...string[]];
    dir = await logDirWith({
      [opener]: 'opened the PR',
      [mentions]: 'reviewed feat/pr-tree, merged PR #14',
    });
    await recordPr(dir, opener, 'https://github.com/o/r/pull/14');

    db = openDb(dir);
    await ingestSessions(db, dir);

    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' }), pr({ number: 15, headRefName: 'feat/pr-15' })];
    const fromFiles = await readPrSessions(dir, prs);
    const fromDb = await readPrSessions(dir, prs, null, dbSource(db));

    expect(fromDb).toEqual(fromFiles);
    expect(fromDb[14]?.map((l) => l.via)).toEqual([['recorded']]);
  });
});
