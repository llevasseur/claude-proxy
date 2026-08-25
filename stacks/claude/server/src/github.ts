/**
 * The project's pull requests, read through the `gh` CLI — `gh pr list` and nothing
 * else, on the device's own auth, so the dashboard needs no token.
 *
 * Setup problems (no `gh`, not signed in, no GitHub remote) come back as a message
 * rather than an exception. The route reads the `pull_request` table and refreshes
 * through here behind the response.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isGitHubHost, type PullRequestRow, parsePullRequests, parseRemoteUrl } from '@agent-proxy/claude-core';
import { findOnPath } from './chat-cli.js';
import {
  newestPullRequestUpdate,
  readStoredPullRequestBody,
  readStoredPullRequests,
  storePullRequests,
} from './db/pull-request-store.js';
import { errorMessage } from './errors.js';
import { type JsonValue, stringField } from './json.js';
import { fetchMainHistory } from './main-history.js';

const run = promisify(execFile);

/**
 * The fields the tree and its drawer read. `body` stays on the list because it is what
 * the stored document holds; it is dropped one layer up, in `buildPullRequests`.
 */
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

/** `owner/name` and nothing else — the form `REPO_SLUG` and `gh` both answer in. */
const SLUG_PATTERN = /^[^/\s]+\/[^/\s]+$/;

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
    return SLUG_PATTERN.test(slug) ? slug : null;
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
    if (SLUG_PATTERN.test(override)) return { slug: override, detail: 'REPO_SLUG' };
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
function ghFailure(cause: unknown): string {
  // SAFETY: every throw reaching here comes from `execFile`, which rejects with an
  // `Error` carrying the child's captured `stderr`; both reads fall back to `''`, so a
  // value thrown from anywhere else degrades to the generic message below.
  const { stderr, message } = cause as { stderr?: string; message?: string };
  const detail = (stderr ?? '').trim() || (message ?? '').trim();
  if (/gh auth login|not logged|authentication/i.test(detail)) {
    return 'not signed in to GitHub — run `gh auth login` on this device';
  }
  return detail || 'gh pr list failed';
}

/**
 * Every pull request up to `limit`, straight from GitHub with no store between — for a
 * caller with no log directory to answer from, which is `ideas-pr.ts` alone. The route
 * uses {@link servePullRequests} instead.
 */
export async function readPullRequests(repoDir: string, limit = DEFAULT_PR_LIMIT): Promise<PullRequestsResult> {
  return fetchPullRequests(repoDir, limit, null);
}

/**
 * One `gh pr list`, plus the ref fetch that draws the rail beside it.
 *
 * `since` is a `YYYY-MM-DD` day: GitHub is asked for `updated:>=<that day>` rather than
 * for the last `limit` pull requests again. `null` asks for everything, the cold case.
 */
async function fetchPullRequests(repoDir: string, limit: number, since: string | null): Promise<PullRequestsResult> {
  const fetchedAt = new Date().toISOString();

  // `main` and its pins ride this pass, so they land behind the response with the PRs.
  // Refs only — never the index, never the worktree — so it is safe in a live checkout.
  const refError = await fetchMainHistory(repoDir).then(
    () => null,
    (cause: unknown) => (errorMessage(cause) || 'could not fetch main and its pins').split('\n').slice(0, 2).join('; '),
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
  } catch (cause) {
    return fail(repo, ghFailure(cause));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail(repo, 'gh returned output that is not JSON');
  }

  return { repo, prs: parsePullRequests(parsed), error: null, fetchedAt, cached: false, refError };
}

/** What one body read answers with, including the gap it could not fill. */
export interface PullRequestBodyResult {
  number: number;
  /** The description, verbatim markdown — null when it could not be read at all. */
  body: string | null;
  /** Whether the row was already on file, rather than fetched for this read. */
  cached: boolean;
  /** Phrased for the drawer, as the list's `error` is. Null when the read succeeded. */
  error: string | null;
}

/**
 * The description of one pull request — the stored document when there is one, and a
 * `gh pr view` for the cold case of a checkout with no substrate to have stored into.
 */
export async function servePullRequestBody(
  logDir: string,
  repoDir: string,
  number: number,
): Promise<PullRequestBodyResult> {
  const stored = readStoredPullRequestBody(logDir, repoDir, number);
  if (stored !== null) return { number, body: stored, cached: true, error: null };

  const gh = findOnPath('gh');
  if (!gh) {
    return { number, body: null, cached: false, error: 'the GitHub CLI is not installed — `brew install gh`' };
  }
  const { slug: repo, detail } = await resolveSlug(gh, repoDir);
  if (!repo)
    return { number, body: null, cached: false, error: `no GitHub repository found for ${repoDir} (${detail})` };

  try {
    const { stdout } = await run(gh, ['pr', 'view', String(number), '--repo', repo, '--json', 'body'], {
      timeout: GH_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed: JsonValue = JSON.parse(stdout);
    // `--json body` always answers with the field, so an absent one is a shape `gh`
    // does not produce; the empty string keeps that indistinguishable from a PR with
    // no description, which is what the drawer already renders.
    return { number, body: stringField(parsed, 'body') ?? '', cached: false, error: null };
  } catch (cause) {
    return { number, body: null, cached: false, error: ghFailure(cause) };
  }
}

/**
 * The day GitHub is asked from, out of the newest `updatedAt` on file. Day granularity
 * re-fetches the watermark's own day rather than risk a boundary dropping an update.
 * Anything that is not a date reads as no watermark, so the refresh asks for everything.
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
 * The floor between two refreshes of the same checkout. The page polls every 30 seconds
 * and every poll starts a pass, so without it the passes run back to back forever —
 * `RECONCILE_MIN_INTERVAL_MS` exists for the same reason on the command store.
 */
export const REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Bring the stored rows level with GitHub, and answer with what GitHub said.
 *
 * Deduped and floored: a pass in flight is shared, and a pass inside
 * {@link REFRESH_MIN_INTERVAL_MS} of the last one returns `null` without running unless
 * `force` — which the cold read passes, having no answer to serve while it waits. The
 * result is returned as well as stored, so that read can serve the pass it waited for
 * even when there is no substrate to have written it into.
 *
 * A thrown failure is swallowed: the rows are a copy of GitHub, and serving yesterday's
 * beats 500-ing the page. A setup failure `gh` itself reported is stored instead, since
 * that is the hint the page renders in place of a tree.
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
 * The wait is the cold case only: an empty table is a state of the cache, not a claim
 * about the repository, so a checkout with no row on file waits for one pass rather than
 * serving an empty tree. Every load after that is one indexed query.
 *
 * `cached` is true for a stored answer, and `fetchedAt` beside it is when the refresh
 * that wrote those rows ran, not now.
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
