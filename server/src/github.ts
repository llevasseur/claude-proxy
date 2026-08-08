/**
 * The project's pull requests, read through the `gh` CLI — `gh pr list` and nothing
 * else, on the device's own auth, so the dashboard needs no token.
 *
 * Setup problems (no `gh`, not signed in, no GitHub remote) come back as a message
 * rather than an exception, and the result is cached briefly.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type PullRequestRow, parsePullRequests, parseRepoSlug } from '@claude-proxy/core';
import { findOnPath } from './chat-cli.js';

const run = promisify(execFile);

/** The fields the tree and its drawer read. */
const PR_FIELDS = [
  'number',
  'title',
  'author',
  'state',
  'isDraft',
  'url',
  'baseRefName',
  'headRefName',
  'body',
  'labels',
  'createdAt',
  'updatedAt',
  'mergedAt',
  'closedAt',
  'additions',
  'deletions',
  'changedFiles',
].join(',');

/** How many PRs to ask for. */
export const DEFAULT_PR_LIMIT = 200;

/** How long a fetch is reused before `gh` is run again. */
const CACHE_MS = 60_000;

/** A subprocess that hangs must not hold the request open. */
const GH_TIMEOUT_MS = 20_000;

/** Everything the route serves, including the failure the page renders as a hint. */
export interface PullRequestsResult {
  /** `owner/name`, or null when the remote is not GitHub. */
  repo: string | null;
  prs: PullRequestRow[];
  /** What went wrong, phrased for the page — null when the read succeeded. */
  error: string | null;
  /** When these rows were read from GitHub. */
  fetchedAt: string;
  /** Whether they came from the cache rather than a fresh `gh` run. */
  cached: boolean;
}

/**
 * The checkout whose PRs are served. `REPO_DIR` overrides it; otherwise this
 * repository, resolved from the module's own path rather than the cwd.
 */
export function resolveRepoDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPO_DIR) return path.resolve(env.REPO_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** The GitHub slug of `repoDir`'s `origin`, or null when it has no GitHub remote. */
async function resolveSlug(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-C', repoDir, 'remote', 'get-url', 'origin'], { timeout: GH_TIMEOUT_MS });
    return parseRepoSlug(stdout);
  } catch {
    return null;
  }
}

/** `gh`'s own stderr is the useful part of a failure; the exit code is not. */
function ghFailure(err: unknown): string {
  const { stderr, message } = err as { stderr?: string; message?: string };
  const detail = (stderr ?? '').trim() || (message ?? '').trim();
  if (/gh auth login|not logged|authentication/i.test(detail)) {
    return 'not signed in to GitHub — run `gh auth login` on this device';
  }
  return detail || 'gh pr list failed';
}

let cache: { key: string; at: number; result: PullRequestsResult } | null = null;

/** Read the repository's pull requests. `limit` caps how many `gh` returns. */
export async function readPullRequests(repoDir: string, limit = DEFAULT_PR_LIMIT): Promise<PullRequestsResult> {
  const key = `${repoDir}:${limit}`;
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return { ...cache.result, cached: true };
  }

  const fetchedAt = new Date().toISOString();
  const fail = (repo: string | null, error: string): PullRequestsResult => ({
    repo,
    prs: [],
    error,
    fetchedAt,
    cached: false,
  });

  const gh = findOnPath('gh');
  if (!gh) return fail(null, 'the GitHub CLI is not installed — `brew install gh`, then `gh auth login`');

  const repo = await resolveSlug(repoDir);
  if (!repo) return fail(null, `no GitHub remote found for ${repoDir}`);

  let stdout: string;
  try {
    ({ stdout } = await run(
      gh,
      ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS],
      { timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
    ));
  } catch (err) {
    return fail(repo, ghFailure(err));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(repo, 'gh returned output that is not JSON');
  }

  const result: PullRequestsResult = { repo, prs: parsePullRequests(parsed), error: null, fetchedAt, cached: false };
  cache = { key, at: Date.now(), result };
  return result;
}
