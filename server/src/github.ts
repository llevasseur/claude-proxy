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
import { newestPullRequestUpdate, readStoredPullRequests, storePullRequests } from './db/pull-request-store.js';
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

/**
 * Read the repository's pull requests straight from GitHub — every one of them, up to
 * `limit`, with no store between.
 *
 * This is the **whole** read for a caller that has no log directory to answer from:
 * `ideas-pr.ts` matches ideas against pull requests from a CLI, once per run. The route
 * does not come through here — see {@link servePullRequests}, which answers from the
 * substrate and calls {@link refreshPullRequests} behind the response.
 */
export async function readPullRequests(repoDir: string, limit = DEFAULT_PR_LIMIT): Promise<PullRequestsResult> {
  return fetchPullRequests(repoDir, limit, null);
}

/**
 * One `gh pr list`, plus the ref fetch that draws the rail beside it.
 *
 * `since` is a `YYYY-MM-DD` day, and it is what makes a refresh incremental: GitHub is
 * asked for `updated:>=<that day>` rather than for the last `limit` pull requests all
 * over again. `null` asks for everything, which is the cold case.
 */
async function fetchPullRequests(repoDir: string, limit: number, since: string | null): Promise<PullRequestsResult> {
  const fetchedAt = new Date().toISOString();

  /**
   * `main` and its pins are fetched on this pass rather than on the page's poll, so the
   * network cost of drawing the rail is the same one `gh pr list` already pays and it
   * lands behind the response with it. It writes refs only — never the index, never the
   * worktree — so it is safe in a checkout being used.
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

  const args = ['pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS];
  if (since) args.push('--search', `updated:>=${since}`);

  let stdout: string;
  try {
    ({ stdout } = await run(gh, args, { timeout: GH_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }));
  } catch (err) {
    return fail(repo, ghFailure(err));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(repo, 'gh returned output that is not JSON');
  }

  return { repo, prs: parsePullRequests(parsed), error: null, fetchedAt, cached: false, refError };
}

/**
 * The day GitHub is asked from, out of the newest `updatedAt` on file.
 *
 * Day granularity rather than the timestamp itself, deliberately: `updated:>=` accepts
 * either, and re-fetching the whole of the watermark's own day is a handful of rows
 * against the risk of a boundary this code got wrong dropping an update on the floor.
 * A watermark that is not a timestamp at all reads as no watermark, so the refresh asks
 * for everything rather than for a window it cannot describe.
 */
function searchDay(newest: string | null): string | null {
  const day = (newest ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** Passes in flight per log directory, so concurrent requests share one. */
const refreshing = new Map<string, Promise<PullRequestsResult | null>>();

/** When the last pass for a log directory finished. */
const refreshedAt = new Map<string, number>();

/**
 * The floor between two refreshes of the same checkout. The page polls every 30
 * seconds and every poll kicks off a pass, so without a floor the passes would run back
 * to back forever — the same reason `RECONCILE_MIN_INTERVAL_MS` exists for the command
 * store.
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Bring the stored rows level with GitHub, and answer with what GitHub said.
 *
 * Deduped and floored: a pass already in flight is shared rather than started twice,
 * and a pass inside {@link REFRESH_MIN_INTERVAL_MS} of the last one returns `null`
 * without running unless `force` says otherwise. `force` is what the cold read uses,
 * because it has no answer to serve while it waits.
 *
 * The result is returned as well as stored so the cold read can serve the pass it just
 * waited for, rather than fetching a second time when there is no substrate to have
 * written it into.
 *
 * A failure is swallowed for the caller that does not wait — the rows are a copy of
 * GitHub, and serving yesterday's beats 500-ing the page. A *setup* failure that GitHub
 * itself reported — no `gh`, not signed in, no remote — is stored rather than swallowed,
 * since that is the hint the page renders in place of a tree.
 */
export function refreshPullRequests(
  logDir: string,
  repoDir: string,
  limit = DEFAULT_PR_LIMIT,
  force = false,
): Promise<PullRequestsResult | null> {
  const held = refreshing.get(logDir);
  if (held) return held;
  if (!force && Date.now() - (refreshedAt.get(logDir) ?? 0) < REFRESH_MIN_INTERVAL_MS) return Promise.resolve(null);

  const pass = (async () => {
    const since = searchDay(newestPullRequestUpdate(logDir, repoDir));
    const result = await fetchPullRequests(repoDir, limit, since);
    const { repo, error, fetchedAt, refError } = result;
    storePullRequests(logDir, repoDir, { repo, error, refError, fetchedAt }, result.prs);
    return result;
  })()
    .catch(() => null)
    .finally(() => {
      refreshedAt.set(logDir, Date.now());
      refreshing.delete(logDir);
    });

  refreshing.set(logDir, pass);
  return pass;
}

/**
 * What the route serves: the rows already on file, with a refresh left running behind
 * the answer.
 *
 * The wait is the cold case only — a substrate that has never held a row for this
 * checkout has nothing to serve, and an empty tree is a claim about the repository
 * rather than a state of the cache. Every load after that is one indexed query.
 *
 * `cached` is true for a stored answer, which is what the page already labels; the
 * `fetchedAt` beside it is when the refresh that wrote those rows ran, not now.
 */
export async function servePullRequests(
  logDir: string,
  repoDir: string,
  limit = DEFAULT_PR_LIMIT,
): Promise<PullRequestsResult> {
  const stored = readStoredPullRequests(logDir, repoDir, limit);
  if (stored) {
    void refreshPullRequests(logDir, repoDir, limit);
    return { ...stored, cached: true };
  }

  const fresh = await refreshPullRequests(logDir, repoDir, limit, true);
  const filled = readStoredPullRequests(logDir, repoDir, limit);
  if (filled) return { ...filled, cached: true };

  // Nothing to read back: no substrate to have stored into, or the pass itself threw.
  // The pass's own result is then the whole answer, exactly as it was before this table
  // existed — and a pass that threw falls through to one direct read.
  return fresh ?? fetchPullRequests(repoDir, limit, null);
}
