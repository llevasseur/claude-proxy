/**
 * The project's pull requests, shaped into the tree the dashboard draws.
 *
 * The trunk is merged PRs in merge order; everything that never landed hangs off the
 * trunk point it was cut from.
 *
 * Pure: no I/O, no clock, no `gh` — the server hands the parsed JSON here.
 */

/** Merged, still open, or closed without merging — the three shapes the tree draws. */
export type PullRequestState = 'open' | 'merged' | 'closed';

/** One pull request, as much of `gh pr list --json` as the page reads. */
export interface PullRequestRow {
  number: number;
  title: string;
  /** GitHub login, or `''` when the account is gone. */
  author: string;
  state: PullRequestState;
  isDraft: boolean;
  url: string;
  baseRefName: string;
  headRefName: string;
  /** The PR description, verbatim markdown. */
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  /** ISO timestamp, or null when it never merged. */
  mergedAt: string | null;
  /** ISO timestamp, or null while it is still open. */
  closedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const iso = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

/** The merge timestamp wins over `state`, so a row with no `state` still classifies. */
function readState(raw: Record<string, unknown>): PullRequestState {
  if (iso(raw.mergedAt) !== null) return 'merged';
  const state = str(raw.state).toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return iso(raw.closedAt) === null ? 'open' : 'closed';
}

/** `author` is an object on the wire, and null for a deleted account. */
function readAuthor(raw: unknown): string {
  if (!raw || typeof raw !== 'object') return '';
  const { login, name } = raw as Record<string, unknown>;
  return str(login) || str(name);
}

/** `labels` is a list of objects; only the names reach the page. */
function readLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => (l && typeof l === 'object' ? str((l as Record<string, unknown>).name) : str(l)))
    .filter(Boolean);
}

/**
 * Read `gh pr list --json …` output into rows, newest first.
 *
 * A row with no usable number is dropped; every other field degrades to an empty
 * value rather than emptying the page.
 */
export function parsePullRequests(raw: unknown): PullRequestRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: PullRequestRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const pr = item as Record<string, unknown>;
    const number = num(pr.number);
    if (number <= 0) continue;
    rows.push({
      number,
      title: str(pr.title),
      author: readAuthor(pr.author),
      state: readState(pr),
      isDraft: pr.isDraft === true,
      url: str(pr.url),
      baseRefName: str(pr.baseRefName),
      headRefName: str(pr.headRefName),
      body: str(pr.body),
      labels: readLabels(pr.labels),
      createdAt: str(pr.createdAt),
      updatedAt: str(pr.updatedAt),
      mergedAt: iso(pr.mergedAt),
      closedAt: iso(pr.closedAt),
      additions: num(pr.additions),
      deletions: num(pr.deletions),
      changedFiles: num(pr.changedFiles),
    });
  }
  return rows.sort((a, b) => b.number - a.number);
}

/** A PR that never landed, and the trunk position it was cut from. */
export interface PrBranch {
  pr: PullRequestRow;
  /** Index into `trunk`, or -1 when it predates every merge — it hangs off the root. */
  after: number;
}

/**
 * The tree: the merged trunk, and the branches that hang off it.
 *
 * `trunk` runs oldest merge first, so reading down it is reading the project forward.
 */
export interface PrTree {
  trunk: PullRequestRow[];
  /** Still open, including drafts. */
  open: PrBranch[];
  /** Closed without merging. */
  closed: PrBranch[];
}

/** Sort key for a merged PR: when it landed, falling back to its number's order. */
const mergedKey = (pr: PullRequestRow): string => pr.mergedAt ?? pr.updatedAt ?? pr.createdAt;

/**
 * The trunk index a PR was cut from: the last merge that had already landed when it
 * was opened. -1 when nothing had, which puts it on the root.
 */
function branchPoint(trunk: PullRequestRow[], pr: PullRequestRow): number {
  const at = pr.createdAt;
  if (!at) return trunk.length - 1;
  let found = -1;
  for (let i = 0; i < trunk.length; i++) {
    if (mergedKey(trunk[i]!) <= at) found = i;
    else break;
  }
  return found;
}

/** Shape rows into the trunk plus its branches. Input order does not matter. */
export function buildPrTree(rows: readonly PullRequestRow[]): PrTree {
  const trunk = rows.filter((pr) => pr.state === 'merged').sort((a, b) => mergedKey(a).localeCompare(mergedKey(b)));
  const branch = (pr: PullRequestRow): PrBranch => ({ pr, after: branchPoint(trunk, pr) });
  const byOpened = (a: PrBranch, b: PrBranch) => a.pr.createdAt.localeCompare(b.pr.createdAt);
  return {
    trunk,
    open: rows
      .filter((pr) => pr.state === 'open')
      .map(branch)
      .sort(byOpened),
    closed: rows
      .filter((pr) => pr.state === 'closed')
      .map(branch)
      .sort(byOpened),
  };
}

/** How many PRs of each state the tree holds — the toolbar's counts. */
export function prCounts(rows: readonly PullRequestRow[]): Record<PullRequestState | 'draft', number> {
  const counts = { open: 0, merged: 0, closed: 0, draft: 0 };
  for (const pr of rows) {
    counts[pr.state] += 1;
    if (pr.isDraft) counts.draft += 1;
  }
  return counts;
}

/** How a transcript was tied to a pull request. */
export type PrSessionVia = 'branch' | 'number';

/** A session transcript that worked on a pull request, as the drawer lists it. */
export interface PrSessionLink {
  threadId: string;
  /** The session's display name, already resolved by the caller. */
  title: string;
  /** Transcript mtime, ISO 8601 — the drawer orders by it. */
  modified: string;
  /** Every way the transcript matched, for the chip beside the link. */
  via: PrSessionVia[];
}

/**
 * Worktree directories flatten a branch's slashes, so `feat/pr-tree` is written
 * `feat-pr-tree` on disk and appears that way in a transcript's paths.
 */
const branchForms = (branch: string): string[] =>
  branch.includes('/') ? [branch, branch.replaceAll('/', '-')] : [branch];

/**
 * A bare `#n` is not evidence on its own — prose numbers steps that way — so the hash
 * form must sit near one of these words. A `/pull/n` url needs no such help.
 */
const HASH_CONTEXT = /\b(?:prs?|pull|pulls|merge|merged|merging)\b/i;

/** How far either side of a `#n` that word is looked for — about a sentence. */
const CONTEXT_CHARS = 90;

/**
 * What may follow a branch name and still be the same name. `/` is absent on purpose:
 * `feat-pr-tree/server` is a path under the worktree, while `feat/pr-tree-page` is a
 * different branch that merely starts the same way.
 */
const BRANCH_TAIL = /[\w.-]/;

/** Whether `text` names `form` as a whole branch rather than the head of a longer one. */
function namesBranch(text: string, form: string): boolean {
  for (let i = text.indexOf(form); i !== -1; i = text.indexOf(form, i + 1)) {
    const after = text[i + form.length];
    if (after === undefined || !BRANCH_TAIL.test(after)) return true;
  }
  return false;
}

/** A matcher for one pull request, compiled once and reused across transcripts. */
export interface PrMatcher {
  match(text: string): PrSessionVia[];
}

/**
 * Compile the two signals a transcript can carry: the branch name, and the PR number
 * as a `/pull/123` url or a `#123`. A branch shorter than four characters is too
 * generic to match on.
 */
export function prMatcher(pr: PullRequestRow): PrMatcher {
  const forms = pr.headRefName.length >= 4 ? branchForms(pr.headRefName) : [];
  // `(?!\d)` throughout, so #14 does not match inside #144.
  const url = new RegExp(`pulls?/${pr.number}(?!\\d)`);
  const hash = new RegExp(`#${pr.number}(?!\\d)`, 'g');

  const refersByNumber = (text: string): boolean => {
    if (url.test(text)) return true;
    hash.lastIndex = 0;
    for (let m = hash.exec(text); m !== null; m = hash.exec(text)) {
      if (HASH_CONTEXT.test(text.slice(Math.max(0, m.index - CONTEXT_CHARS), m.index + CONTEXT_CHARS))) return true;
    }
    return false;
  };

  return {
    match(text: string): PrSessionVia[] {
      const via: PrSessionVia[] = [];
      if (forms.some((form) => namesBranch(text, form))) via.push('branch');
      if (refersByNumber(text)) via.push('number');
      return via;
    },
  };
}

/** How a transcript refers to a pull request, if it does. */
export function matchPrInText(pr: PullRequestRow, text: string): PrSessionVia[] {
  return prMatcher(pr).match(text);
}

/** `owner/name` from a git remote url, or null when it is not a GitHub remote. */
export function parseRepoSlug(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  const match = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}
