import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type IdeaPrLink,
  type IdeaPrObservation,
  type IdeaPrPlan,
  type IdeaPrTransition,
  ideaPrLinks,
  type PullRequestRow,
  planIdeaPrTransitions,
  sameIdeaPr,
  type WriteProvenance,
} from '@claude-proxy/core';
import { readPullRequests, resolveRepoDir } from './github.js';
import { markIdeasInStore, readIdeasStore } from './ideas-store.js';

/**
 * Turn observed pull-request state into ideas-ledger status changes.
 *
 * **The problem this solves is a manual step.** An idea is `claimed` by the run
 * that starts building it, with the PR url recorded on the claim; when that PR
 * merged, somebody still had to remember to say `ideas mark -s shipped`. Nothing
 * read the PR. So a merged idea sat `claimed` until a human noticed, and a PR
 * that was closed or whose branch was deleted left the idea claimed **forever**,
 * because a claim carrying a `pr` deliberately never goes stale.
 *
 * The decision is pure and lives in `@claude-proxy/core` (`planIdeaPrTransitions`).
 * This module does the two impure halves: read what GitHub says, and write the
 * plan. It is called from `ideas sync` and, unattended, from the scheduled
 * `maintain --apply` job.
 */

const run = promisify(execFile);

/** Same ceiling `github.ts` puts on a `gh` call — this shells out beside it. */
const GIT_TIMEOUT_MS = 20_000;

/**
 * The branches that still exist on the remote.
 *
 * `null` means the question could not be answered — no network, no remote, a
 * detached checkout — and every caller below reads that as **"assume every
 * branch is alive"** rather than as "every branch is gone". Getting this
 * backwards would release every open claim on the ledger the first time a
 * scheduled run happened to be offline.
 */
async function readRemoteHeads(repoDir: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await run('git', ['-C', repoDir, 'ls-remote', '--heads', 'origin'], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    const heads = new Set<string>();
    for (const line of stdout.split('\n')) {
      const ref = line.split('\t')[1]?.trim();
      if (ref?.startsWith('refs/heads/')) heads.add(ref.slice('refs/heads/'.length));
    }
    // An empty answer from a repo that has a remote is still not evidence of
    // deletion — it is likelier a shape we did not parse.
    return heads.size > 0 ? heads : null;
  } catch {
    return null;
  }
}

/**
 * What one PR row means for a claim.
 *
 * `merged` and `closed` come straight off the row. `detached` is the inferred
 * one: an **open** PR whose head branch is no longer on the remote. That is the
 * shape a squash-merge-then-delete leaves behind if the merge itself was not
 * recorded, and the shape an abandoned branch leaves behind too — either way
 * nothing is being built, so the claim should not keep holding the idea.
 */
export function observePullRequest(pr: PullRequestRow, remoteHeads: Set<string> | null): IdeaPrObservation {
  if (pr.state === 'merged') return { pr: pr.url, outcome: 'merged' };
  if (pr.state === 'closed') return { pr: pr.url, outcome: 'closed' };
  if (remoteHeads && pr.headRefName && !remoteHeads.has(pr.headRefName)) {
    return { pr: pr.url, outcome: 'detached' };
  }
  return { pr: pr.url, outcome: 'open' };
}

/** Everything one reconciliation looked at and did. */
export interface IdeaPrSyncResult extends IdeaPrPlan {
  /** The repo whose PRs were read, as `owner/name`, or null when it could not be resolved. */
  repo: string | null;
  /** True when the plan was only computed. */
  dryRun: boolean;
  /** The ledger file written, or null on a dry run or an empty plan. */
  file: string | null;
  /**
   * Why the run could see nothing, when it could see nothing — a missing `gh`,
   * an unauthenticated one, no origin. Distinct from an empty plan, which is a
   * successful run with nothing to do.
   */
  error: string | null;
}

const EMPTY = (
  repo: string | null,
  dryRun: boolean,
  error: string | null,
  unobserved: IdeaPrLink[],
): IdeaPrSyncResult => ({
  transitions: [],
  marks: [],
  unchanged: [],
  unobserved,
  repo,
  dryRun,
  file: null,
  error,
});

export interface IdeaPrSyncOptions {
  /** Compute the plan and write nothing. */
  dryRun?: boolean;
  /** Stamped onto each mark, exactly as `ideas mark --thread` does. */
  by?: WriteProvenance;
  /** Overrides the repo the PRs are read from; defaults to {@link resolveRepoDir}. */
  repoDir?: string;
  now?: Date;
}

/**
 * Read the linked PRs, decide, and (unless `dryRun`) write.
 *
 * **A linked PR the listing does not cover is reported, never guessed at.** The
 * listing is capped at {@link DEFAULT_PR_LIMIT} and reads one repo, while the
 * ledger is device-wide and may carry ideas from another; an absent PR is
 * missing data, and treating it as closed would silently release live claims.
 * Those links come back under `unobserved`.
 */
export async function reconcileIdeaPrs(logDir: string, options: IdeaPrSyncOptions = {}): Promise<IdeaPrSyncResult> {
  const { dryRun = false, by, repoDir = resolveRepoDir(), now = new Date() } = options;

  const store = await readIdeasStore(logDir);
  const links = ideaPrLinks(store);
  // No linked idea means no reason to spend a `gh` call.
  if (links.length === 0) return EMPTY(null, dryRun, null, []);

  const listing = await readPullRequests(repoDir);
  if (listing.error) return EMPTY(listing.repo, dryRun, listing.error, links);

  const remoteHeads = await readRemoteHeads(repoDir);
  const observations = listing.prs
    .filter((pr) => links.some((link) => sameIdeaPr(link.pr, pr.url)))
    .map((pr) => observePullRequest(pr, remoteHeads));

  const plan = planIdeaPrTransitions(store, observations, by);
  if (dryRun || plan.marks.length === 0) {
    return { ...plan, repo: listing.repo, dryRun, file: null, error: null };
  }

  const written = await markIdeasInStore(logDir, plan.marks, now);
  return { ...plan, repo: listing.repo, dryRun, file: written.file, error: null };
}

/** One transition as a log line, for the CLI and the scheduled job alike. */
export function renderIdeaPrTransition(t: IdeaPrTransition): string {
  return `${t.slug}: ${t.from} → ${t.to} — ${t.why}`;
}
