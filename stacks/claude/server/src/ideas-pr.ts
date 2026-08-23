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
} from '@agent-proxy/claude-core';
import { readPullRequests, resolveRepoDir } from './github.js';
import { markIdeasInStore, readIdeasStore } from './ideas-store.js';

/**
 * Turn observed pull-request state into ideas-ledger status changes, so a merged
 * PR ships the idea it was claimed against without anyone saying so.
 *
 * The decision is pure and lives in `@agent-proxy/claude-core` (`planIdeaPrTransitions`).
 * This module does the two impure halves: read what GitHub says, and write the
 * plan. Called from `ideas sync` and, unattended, from `maintain --apply`.
 */

const run = promisify(execFile);

/** Same ceiling `github.ts` puts on a `gh` call — this shells out beside it. */
const GIT_TIMEOUT_MS = 20_000;

/**
 * The branches that still exist on the remote. `null` means the question could
 * not be answered — no network, no remote, a detached checkout — and every
 * caller reads that as **"assume every branch is alive"**; the other reading
 * would release every open claim the first time a scheduled run ran offline.
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
    // An empty answer is not evidence of deletion — likelier a shape we did not parse.
    return heads.size > 0 ? heads : null;
  } catch {
    return null;
  }
}

/**
 * What one PR row means for a claim. `merged` and `closed` come straight off the
 * row; `detached` is inferred — an **open** PR whose head branch is no longer on
 * the remote, which is what an abandoned branch leaves behind.
 *
 * **The inference assumes the head branch lives on `origin`.** {@link PullRequestRow}
 * carries `headRefName` and no head repository, so a PR opened from a fork has a
 * branch name `origin` was never going to list and reads as `detached`. Every PR
 * this repo's tooling serves is same-repo, and widening it would mean a field
 * `gh pr list` is not currently asked for.
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
  /**
   * The repo whose PRs were read, as `owner/name`. Null when no listing was read
   * at all — either the ledger carries no linked PR, or the repo could not be
   * resolved; `error` is what tells those apart.
   */
  repo: string | null;
  /** True when the plan was only computed. */
  dryRun: boolean;
  /** The ledger file written, or null on a dry run or an empty plan. */
  file: string | null;
  /**
   * Why the run could see nothing — a missing `gh`, an unauthenticated one, no
   * origin. Distinct from an empty plan, a successful run with nothing to do.
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
}

/**
 * Read the linked PRs, decide, and (unless `dryRun`) write.
 *
 * **A linked PR the listing does not cover comes back under `unobserved`, never
 * guessed at.** The listing is capped and reads one repo while the ledger is
 * device-wide, so an absent PR is missing data; treating it as closed would
 * silently release live claims.
 */
export async function reconcileIdeaPrs(options: IdeaPrSyncOptions = {}): Promise<IdeaPrSyncResult> {
  // No `now`: the hosted ledger stamps every write with its own clock, so a
  // caller's idea of the time is no longer the ledger's. See ADR 0006.
  const { dryRun = false, by, repoDir = resolveRepoDir() } = options;

  const store = await readIdeasStore();
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

  const written = await markIdeasInStore(plan.marks);
  return { ...plan, repo: listing.repo, dryRun, file: written.file, error: null };
}

/** One transition as a log line, for the CLI and the scheduled job alike. */
export function renderIdeaPrTransition(t: IdeaPrTransition): string {
  return `${t.slug}: ${t.from} → ${t.to} — ${t.why}`;
}
