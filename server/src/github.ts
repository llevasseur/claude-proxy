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
import { isGitHubHost, type PullRequestRow, parsePullRequests, parseRemoteUrl } from '@claude-proxy/core';
import { findOnPath } from './chat-cli.js';
import { fetchMainHistory } from './main-history.js';

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
  // The commit a merged PR landed on `main` — a squash commit here, a true merge commit
  // in the early history. It is the position `main` can be slid to.
  'mergeCommit',
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
  /**
   * Why `main` and its pins could not be brought up to date, if they could not. The page
   * still renders — it just draws the rail from whatever the ref store already had.
   */
  refError: string | null;
}

/**
 * The checkout whose PRs are served. `REPO_DIR` overrides it; otherwise this
 * repository, resolved from the module's own path rather than the cwd.
 */
export function resolveRepoDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REPO_DIR) return path.resolve(env.REPO_DIR);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** `owner/name` and nothing else — the shape `REPO_SLUG` and `gh` both answer in. */
const SLUG_SHAPE = /^[^/\s]+\/[^/\s]+$/;

/** `ssh -G` reads config files only; it never opens a connection. */
const SSH_TIMEOUT_MS = 5_000;

/** What was established, and how — the `how` is what a failure reports. */
interface SlugLookup {
  slug: string | null;
  detail: string;
}

/**
 * The url `origin` is fetched from, with any `url.<base>.insteadOf` rewrite already
 * applied — which `git remote get-url` does not do and `ls-remote --get-url` does.
 */
async function originUrl(repoDir: string): Promise<string | null> {
  for (const args of [
    ['ls-remote', '--get-url', 'origin'],
    ['remote', 'get-url', 'origin'],
  ]) {
    try {
      const { stdout } = await run('git', ['-C', repoDir, ...args], { timeout: GH_TIMEOUT_MS });
      const url = stdout.trim();
      // `ls-remote --get-url` echoes the name back when there is no such remote.
      if (url && url !== 'origin') return url;
    } catch {
      // Try the next spelling; both failing means no origin.
    }
  }
  return null;
}

/**
 * The host an ssh alias stands for, per this device's `~/.ssh/config`. A per-account ssh
 * identity names a host that exists nowhere but that file, so only `ssh` itself can say
 * whether it is GitHub. Returns the alias unchanged when no `Host` block matches.
 */
async function resolveSshAlias(host: string): Promise<string | null> {
  try {
    const { stdout } = await run('ssh', ['-G', host], { timeout: SSH_TIMEOUT_MS });
    return /^hostname\s+(\S+)$/im.exec(stdout)?.[1]?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

/** What `gh` itself makes of the checkout — the last word, and it resolves aliases too. */
async function ghSlug(gh: string, repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await run(gh, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
      cwd: repoDir,
      timeout: GH_TIMEOUT_MS,
    });
    const slug = stdout.trim();
    return SLUG_SHAPE.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/**
 * The GitHub slug of `repoDir`'s `origin`, tried four ways so that no device's remote
 * spelling is the one this feature cannot read:
 *
 * 1. `REPO_SLUG`, when the checkout's remote cannot speak for itself at all.
 * 2. `origin`'s url, parsed for any host rather than a literal `github.com`.
 * 3. `ssh -G` on that host, which is what turns an ssh alias into a real hostname.
 * 4. `gh repo view` in the checkout, which resolves the remote on `gh`'s own terms.
 *
 * No token or device path is read here — swapping the identity `gh` and `git`
 * authenticate with changes nothing above.
 */
export async function resolveSlug(
  gh: string,
  repoDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlugLookup> {
  const override = env.REPO_SLUG?.trim();
  if (override) {
    if (SLUG_SHAPE.test(override)) return { slug: override, detail: 'REPO_SLUG' };
    return { slug: null, detail: `REPO_SLUG is \`${override}\`, which is not \`owner/name\`` };
  }

  const url = await originUrl(repoDir);
  const parsed = url ? parseRemoteUrl(url) : null;
  // The same variable `gh` itself reads for an Enterprise install.
  const extraHosts = env.GH_HOST?.trim() ? [env.GH_HOST] : [];

  if (parsed) {
    if (isGitHubHost(parsed.host, extraHosts)) return { slug: parsed.slug, detail: parsed.host };
    if (parsed.scheme === 'ssh') {
      const real = await resolveSshAlias(parsed.host);
      if (real && real !== parsed.host && isGitHubHost(real, extraHosts)) {
        return { slug: parsed.slug, detail: `${parsed.host} → ${real}` };
      }
    }
  }

  const fromGh = await ghSlug(gh, repoDir);
  if (fromGh) return { slug: fromGh, detail: 'gh repo view' };

  return { slug: null, detail: url ? `\`origin\` is \`${url}\`` : '`origin` is not set' };
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

  /**
   * `main` and its pins ride this cache rather than the page's 30s poll, so the network
   * cost of drawing the rail is the same one `gh pr list` already pays. It writes refs
   * only — never the index, never the worktree — so it is safe in a checkout being used.
   */
  const refError = await fetchMainHistory(repoDir).then(
    () => null,
    (err: unknown) =>
      ((err as Error).message || 'could not fetch main and its pins').split('\n').slice(0, 2).join('; '),
  );

  const fail = (repo: string | null, error: string): PullRequestsResult => ({
    repo,
    prs: [],
    error,
    fetchedAt,
    cached: false,
    refError,
  });

  const gh = findOnPath('gh');
  if (!gh) return fail(null, 'the GitHub CLI is not installed — `brew install gh`, then `gh auth login`');

  const { slug: repo, detail } = await resolveSlug(gh, repoDir);
  if (!repo) {
    return fail(
      null,
      `no GitHub repository found for ${repoDir} (${detail}) — set REPO_SLUG=owner/name if this checkout's remote cannot be read`,
    );
  }

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

  const result: PullRequestsResult = {
    repo,
    prs: parsePullRequests(parsed),
    error: null,
    fetchedAt,
    cached: false,
    refError,
  };
  cache = { key, at: Date.now(), result };
  return result;
}
