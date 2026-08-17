// A session records the pull request it opened, and the transcript scan is the fallback for
// one nothing recorded — so these cases are written as files on disk (transcripts, and the
// `.state.json` sidecars carrying the record) rather than as calls into the matcher.
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PullRequestRow } from '@claude-proxy/core';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestSessions } from '../src/db/ingest-sessions.js';
import { openDb } from '../src/db/open.js';
import { clearScannedPrLinks } from '../src/db/pr-scan-store.js';
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

// A fixed 3-element tuple, so every destructure below reads straight off its length.
const THREADS = ['0123456789abcdef', 'fedcba9876543210', 'abcdefabcdef0123'] as const;

/** The checkout the scanned links are keyed under. Nothing reads it off disk. */
const REPO_DIR = '/repo/o-r';

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
    const [built, reviewed, both] = THREADS;
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
    const [only] = THREADS;
    const dir = await logDirWith({ [only]: 'shipped on feat/pr-tree-page today' });

    const index = await readPrSessions(dir, [
      pr({ number: 14, headRefName: 'feat/pr-tree' }),
      pr({ number: 15, headRefName: 'feat/pr-tree-page' }),
    ]);

    expect(index[14]).toBeUndefined();
    expect(index[15]?.map((l) => l.threadId)).toEqual([only]);
  });

  it('ignores files that are not transcripts, and a missing sessions directory', async () => {
    const [only] = THREADS;
    const dir = await logDirWith({ [only]: 'nothing to see' });
    await writeFile(path.join(dir, 'sessions', 'notes.md'), 'merged PR #14', 'utf8');

    expect(await readPrSessions(dir, [pr({ number: 14 })])).toEqual({});
    expect(await readPrSessions(path.join(dir, 'nope'), [pr({ number: 14 })])).toEqual({});
  });

  it('is an empty index when there are no pull requests to match', async () => {
    const [only] = THREADS;
    const dir = await logDirWith({ [only]: 'merged PR #14' });
    expect(await readPrSessions(dir, [])).toEqual({});
  });

  it('scans every transcript again when there is no substrate to store the result in', async () => {
    const [first, second] = THREADS;
    const dir = await logDirWith({ [first]: 'merged PR #14' });
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    const before = await readPrSessions(dir, prs, REPO_DIR);
    expect(before[14]?.map((l) => l.threadId)).toEqual([first]);

    await writeFile(path.join(dir, 'sessions', `${second}.md`), '# session\n\nmerged PR #14\n', 'utf8');

    const after = await readPrSessions(dir, prs, REPO_DIR);
    expect(after[14]?.map((l) => l.threadId).sort()).toEqual([first, second].sort());
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
    const [opener, mentions] = THREADS;
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
    const [opener, other] = THREADS;
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
    const [elsewhere] = THREADS;
    dir = await logDirWith({ [elsewhere]: 'nothing about this repo' });
    await recordPr(dir, elsewhere, 'https://github.com/other/repo/pull/14');

    // Same number, different repository — so #14 here is still unnamed, and the scan that
    // then runs finds nothing in that transcript either.
    expect(await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-14' })])).toEqual({});
  });

  it('drops a recorded link whose transcript has rotated away', async () => {
    const [gone] = THREADS;
    dir = await mkdtemp(path.join(tmpdir(), 'pr-sessions-'));
    await mkdir(path.join(dir, 'sessions'), { recursive: true });
    await recordPr(dir, gone, 'https://github.com/o/r/pull/14');

    expect(await readPrSessions(dir, [pr({ number: 14, headRefName: 'feat/pr-14' })])).toEqual({});
  });

  it('answers the same from the substrate as from the sidecars', async () => {
    const [opener, mentions] = THREADS;
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

/**
 * The scan's own results, kept. A stored answer is proved by rewriting a transcript's
 * *body* while holding its mtime still: nothing on disk says the file changed, so a read
 * that still answers the old way did not open it.
 */
describe('readPrSessions, on the stored scan', () => {
  let dir: string;

  /** A log directory with a substrate, since a read route never creates one. */
  async function storedLogDirWith(transcripts: Record<string, string>): Promise<string> {
    const root = await logDirWith(transcripts);
    openDb(root).close();
    return root;
  }

  /** Backdate a transcript, so "newer than the mark" is a decision and not a race. */
  async function setMtime(root: string, threadId: string, when: string): Promise<void> {
    const at = new Date(when);
    await utimes(path.join(root, 'sessions', `${threadId}.md`), at, at);
  }

  /** Every stored link for the checkout, whatever pull request it belongs to. */
  function storedLinks(root: string): { number: number; thread_id: string; via: string }[] {
    const db = openDb(root);
    const rows = db.prepare('SELECT number, thread_id, via FROM pr_scan_link WHERE repo_dir = ?').all(REPO_DIR);
    db.close();
    // SAFETY: `pr_scan_link` is written only by the readPrSessions storage path in
    // server/src/pr-sessions.ts, whose insert names exactly these three columns —
    // `.all()` types generically as `unknown[]` because node:sqlite has no column typing.
    return rows as { number: number; thread_id: string; via: string }[];
  }

  /** The pull requests marked as scanned, ascending. */
  function storedMarks(root: string): number[] {
    const db = openDb(root);
    const rows = db.prepare('SELECT number FROM pr_scan WHERE repo_dir = ? ORDER BY number').all(REPO_DIR);
    db.close();
    // SAFETY: `pr_scan` is written only by the same storage path with a single `number`
    // column per scanned pull request — `.all()` has no column typing to carry that through.
    return (rows as { number: number }[]).map((row) => row.number);
  }

  afterEach(async () => {
    clearScannedPrLinks();
    await rm(dir, { recursive: true, force: true });
  });

  it('answers a second read from the stored links, without opening the transcripts again', async () => {
    const [found] = THREADS;
    dir = await storedLogDirWith({ [found]: 'merged PR #14' });
    await setMtime(dir, found, '2026-08-10T10:00:00Z');
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    expect((await readPrSessions(dir, prs, REPO_DIR))[14]?.map((l) => l.threadId)).toEqual([found]);
    expect(storedLinks(dir)).toEqual([{ number: 14, thread_id: found, via: 'number' }]);

    // The body no longer mentions #14 at all, but the file is not newer than the mark.
    await writeFile(path.join(dir, 'sessions', `${found}.md`), '# session\n\nnothing at all\n', 'utf8');
    await setMtime(dir, found, '2026-08-10T10:00:00Z');

    expect((await readPrSessions(dir, prs, REPO_DIR))[14]?.map((l) => l.threadId)).toEqual([found]);
  });

  it('remembers a pull request nothing matched, so it is not scanned a second time', async () => {
    const [quiet] = THREADS;
    dir = await storedLogDirWith({ [quiet]: 'nothing about any pull request' });
    await setMtime(dir, quiet, '2026-08-10T10:00:00Z');
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    expect(await readPrSessions(dir, prs, REPO_DIR)).toEqual({});
    // The mark is the useful negative: scanned, matched nothing.
    expect(storedMarks(dir)).toEqual([14]);
    expect(storedLinks(dir)).toEqual([]);

    // Backdated, so nothing on disk claims to be newer than the mark.
    await writeFile(path.join(dir, 'sessions', `${quiet}.md`), '# session\n\nmerged PR #14\n', 'utf8');
    await setMtime(dir, quiet, '2026-08-10T10:00:00Z');

    expect(await readPrSessions(dir, prs, REPO_DIR)).toEqual({});
  });

  it('rescans once a newer transcript arrives, and keeps the links it already had', async () => {
    const [first, second] = THREADS;
    dir = await storedLogDirWith({ [first]: 'merged PR #14' });
    await setMtime(dir, first, '2026-08-10T10:00:00Z');
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    await readPrSessions(dir, prs, REPO_DIR);

    await writeFile(path.join(dir, 'sessions', `${second}.md`), '# session\n\nmerged PR #14\n', 'utf8');
    await setMtime(dir, second, '2026-08-12T10:00:00Z');

    const after = await readPrSessions(dir, prs, REPO_DIR);
    expect(after[14]?.map((l) => l.threadId).sort()).toEqual([first, second].sort());
    expect(
      storedLinks(dir)
        .map((row) => row.thread_id)
        .sort(),
    ).toEqual([first, second].sort());
  });

  it('survives the process that scanned, so a restart does not rescan', async () => {
    const [found] = THREADS;
    dir = await storedLogDirWith({ [found]: 'merged PR #14' });
    await setMtime(dir, found, '2026-08-10T10:00:00Z');
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    await readPrSessions(dir, prs, REPO_DIR);
    // A connection this process never opened is what a restarted server reads through.
    expect(storedMarks(dir)).toEqual([14]);

    // The body would no longer match, and the mark is what says not to look.
    await writeFile(path.join(dir, 'sessions', `${found}.md`), '# session\n\nnothing at all\n', 'utf8');
    await setMtime(dir, found, '2026-08-10T10:00:00Z');

    expect((await readPrSessions(dir, prs, REPO_DIR))[14]?.map((l) => l.threadId)).toEqual([found]);
  });

  it('never stores a recorded link, only the recovered signals', async () => {
    const [opener, mentions] = THREADS;
    dir = await storedLogDirWith({ [opener]: 'opened it', [mentions]: 'shipped feat/pr-15 earlier' });
    await recordPr(dir, opener, 'https://github.com/o/r/pull/14');
    await setMtime(dir, opener, '2026-08-10T10:00:00Z');
    await setMtime(dir, mentions, '2026-08-10T10:00:00Z');

    const index = await readPrSessions(
      dir,
      [pr({ number: 14, headRefName: 'feat/pr-14' }), pr({ number: 15, headRefName: 'feat/pr-15' })],
      REPO_DIR,
    );

    expect(index[14]?.map((l) => l.via)).toEqual([['recorded']]);
    // #14 was never scanned, so it has neither a mark nor a stored link.
    expect(storedMarks(dir)).toEqual([15]);
    expect(storedLinks(dir)).toEqual([{ number: 15, thread_id: mentions, via: 'branch' }]);
  });

  it('drops a stored link whose transcript has rotated away, and keeps the mark', async () => {
    const [gone] = THREADS;
    dir = await storedLogDirWith({ [gone]: 'merged PR #14' });
    await setMtime(dir, gone, '2026-08-10T10:00:00Z');
    const prs = [pr({ number: 14, headRefName: 'feat/pr-tree' })];

    await readPrSessions(dir, prs, REPO_DIR);
    await rm(path.join(dir, 'sessions', `${gone}.md`));

    expect(await readPrSessions(dir, prs, REPO_DIR)).toEqual({});
    expect(storedLinks(dir)).toEqual([]);
    expect(storedMarks(dir)).toEqual([14]);
  });
});
