/**
 * `/api/pull-requests` answering from the `pull_request` table, and the refresh that
 * fills it behind the response.
 *
 * `gh` is a shell script on a temp `PATH` that records the argv it was called with and
 * prints whatever the test staged — so the search qualifier the refresh builds is
 * asserted directly, and no test reaches GitHub. `REPO_SLUG` short-circuits the slug
 * lookup, which `github-remote.test.ts` covers on its own. The repositories have no
 * `origin`, so the ref fetch fails fast and locally; it is a `refError` on the row and
 * never a reason the page does not render.
 */
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { type PullRequestRow, parsePullRequests } from '@claude-proxy/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db/open.js';
import {
  clearStoredPullRequests,
  newestPullRequestUpdate,
  readStoredPullRequests,
  storePullRequests,
} from '../src/db/pull-request-store.js';
import { refreshPullRequests, servePullRequests } from '../src/github.js';

const run = promisify(execFile);

/** One `gh pr list --json` row, with only the fields a test varies spelled out. */
function ghRow(number: number, updatedAt: string, title = `PR ${number}`): Record<string, unknown> {
  return {
    number,
    title,
    author: { login: 'llevasseur' },
    state: 'OPEN',
    isDraft: false,
    url: `https://github.com/o/r/pull/${number}`,
    baseRefName: 'main',
    headRefName: `feat/pr-${number}`,
    body: '',
    labels: [],
    createdAt: updatedAt,
    updatedAt,
    mergedAt: null,
    mergeCommit: null,
    closedAt: null,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  };
}

/** The same row, through the parser the fetch uses — what a stored row holds. */
function prRow(number: number, updatedAt: string, title?: string): PullRequestRow {
  return parsePullRequests([ghRow(number, updatedAt, title)])[0] as PullRequestRow;
}

let logDir: string;
let repoDir: string;
let binDir: string;
let argvLog: string;
let responsePath: string;
let realPath: string | undefined;

/** What the next `gh pr list` prints. */
async function stageGh(rows: Record<string, unknown>[]): Promise<void> {
  await writeFile(responsePath, JSON.stringify(rows), 'utf8');
}

/** Every `gh` invocation since the last reset, one argv per line. */
async function ghCalls(): Promise<string[]> {
  const text = await readFile(argvLog, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean);
}

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'pr-store-logs-'));
  repoDir = await mkdtemp(path.join(tmpdir(), 'pr-store-repo-'));
  binDir = await mkdtemp(path.join(tmpdir(), 'pr-store-bin-'));
  await run('git', ['-C', repoDir, 'init', '--quiet']);

  argvLog = path.join(binDir, 'argv.log');
  responsePath = path.join(binDir, 'response.json');
  await writeFile(argvLog, '', 'utf8');
  await stageGh([]);

  const gh = path.join(binDir, 'gh');
  await writeFile(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${argvLog}"\ncat "${responsePath}"\n`, 'utf8');
  await chmod(gh, 0o755);

  realPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${realPath ?? ''}`;
  process.env.REPO_SLUG = 'o/r';

  // The substrate has to exist for the store to open it — a read route never creates one.
  openDb(logDir).close();
});

afterEach(async () => {
  // A pass left running behind a served response resolves `gh` off `process.env.PATH`
  // when it gets there, which the next test has already swapped — so it would be logged
  // against that test's fake. Settling it here is what keeps the counts each test's own.
  await refreshPullRequests(logDir, repoDir);
  clearStoredPullRequests();
  process.env.PATH = realPath;
  delete process.env.REPO_SLUG;
});

describe('the pull request store', () => {
  it('asks GitHub for everything when nothing is on file, and serves what it stored', async () => {
    await stageGh([ghRow(2, '2026-08-10T10:00:00Z'), ghRow(1, '2026-08-09T10:00:00Z')]);

    const served = await servePullRequests(logDir, repoDir, 200);

    expect(served.prs.map((pr) => pr.number)).toEqual([2, 1]);
    expect(served.repo).toBe('o/r');
    expect(served.error).toBeNull();
    // A cold pass has no watermark, so it carries no search qualifier.
    const calls = await ghCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('pr list');
    expect(calls[0]).not.toContain('--search');
  });

  it('answers a warm read from the rows rather than from gh', async () => {
    storePullRequests(
      logDir,
      repoDir,
      { repo: 'o/r', error: null, refError: null, fetchedAt: '2026-08-10T10:00:00Z' },
      [prRow(7, '2026-08-10T10:00:00Z')],
    );
    // Whatever `gh` would say, the answer is the row — and it is the answer before any
    // pass behind it could have finished.
    await stageGh([ghRow(99, '2026-08-16T10:00:00Z')]);

    const served = await servePullRequests(logDir, repoDir, 200);

    expect(served.prs.map((pr) => pr.number)).toEqual([7]);
    expect(served.cached).toBe(true);
    expect(served.fetchedAt).toBe('2026-08-10T10:00:00Z');
  });

  it('asks only for what changed since the newest updated_at on file', async () => {
    await stageGh([ghRow(2, '2026-08-10T10:00:00Z'), ghRow(1, '2026-08-09T10:00:00Z')]);
    await refreshPullRequests(logDir, repoDir, 200, true);

    expect(newestPullRequestUpdate(logDir, repoDir)).toBe('2026-08-10T10:00:00Z');

    await stageGh([ghRow(3, '2026-08-11T09:00:00Z')]);
    await refreshPullRequests(logDir, repoDir, 200, true);

    const calls = await ghCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).not.toContain('--search');
    expect(calls[1]).toContain('--search updated:>=2026-08-10');
  });

  it('upserts a changed row in place and keeps the ones the search did not return', async () => {
    await stageGh([ghRow(2, '2026-08-10T10:00:00Z', 'first'), ghRow(1, '2026-08-09T10:00:00Z')]);
    await refreshPullRequests(logDir, repoDir, 200, true);

    // An incremental pass returns only #2, changed. #1 was never asked about.
    await stageGh([ghRow(2, '2026-08-11T11:00:00Z', 'retitled')]);
    await refreshPullRequests(logDir, repoDir, 200, true);

    const stored = readStoredPullRequests(logDir, repoDir, 200);
    expect(stored?.prs.map((pr) => pr.number)).toEqual([2, 1]);
    expect(stored?.prs[0]?.title).toBe('retitled');
    expect(newestPullRequestUpdate(logDir, repoDir)).toBe('2026-08-11T11:00:00Z');
  });

  it('survives the process that wrote it', async () => {
    await stageGh([ghRow(5, '2026-08-10T10:00:00Z')]);
    await refreshPullRequests(logDir, repoDir, 200, true);

    // A second connection is what a restarted server has: the rows are on disk, not in
    // this process's memory, which is the whole difference from the single slot.
    const db = openDb(logDir);
    const row = db.prepare('SELECT COUNT(*) AS n FROM pull_request WHERE repo_dir = ?').get(repoDir) as { n: number };
    db.close();
    expect(row.n).toBe(1);
  });

  it('does not run gh again inside the refresh floor', async () => {
    await stageGh([ghRow(2, '2026-08-10T10:00:00Z')]);
    await servePullRequests(logDir, repoDir, 200);

    await servePullRequests(logDir, repoDir, 200);
    await servePullRequests(logDir, repoDir, 200);

    expect(await ghCalls()).toHaveLength(1);
  });

  it('stores a setup failure as the hint the page renders', async () => {
    // No `gh` on PATH at all — the first layer of the failure the route reports.
    process.env.PATH = path.join(tmpdir(), 'pr-store-empty-bin');

    const served = await servePullRequests(logDir, repoDir, 200);

    expect(served.prs).toEqual([]);
    expect(served.error).toContain('GitHub CLI is not installed');
    expect(readStoredPullRequests(logDir, repoDir, 200)?.error).toContain('GitHub CLI is not installed');
  });
});
