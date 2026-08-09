/**
 * Moving `main`, and everything that has to be true before it moves.
 *
 * `main` is slid by force-pushing `refs/heads/main` at the commit a merged pull request
 * landed. The one rule that keeps this safe is that **nothing is ever destroyed**:
 * before `main` leaves a commit, that commit is pinned under `refs/main-history/` unless
 * something already reaches it. GitHub's own merges only ever append to `main`, so a
 * slide from here is the only thing that can strand a commit — enforcing the rule at
 * slide time is enough, and no journal has to be kept.
 *
 * All shared state is git refs on `origin`. Nothing is written to SQLite: the database is
 * per-device and the several machines this runs on would disagree about where `main` has
 * been, whereas a ref is the same fact everywhere.
 *
 * Everything here shells out to `git` and `gh`. The pure layout lives in
 * `@claude-proxy/core`'s `main-history.ts`.
 */

import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  buildMainHistory,
  hiddenRefFor,
  localOrphanRefFor,
  MAIN_HISTORY_PREFIX,
  type MainHistoryCommit,
  type MainHistoryGraph,
  type MainHistoryRef,
  type MainPosition,
  needsPin,
  pinRefFor,
  shortSha,
} from '@claude-proxy/core';
import { findOnPath } from './chat-cli.js';

const run = promisify(execFile);

/** A hung subprocess must not hold a request open. Pushes get longer than reads. */
const GIT_TIMEOUT_MS = 20_000;
const PUSH_TIMEOUT_MS = 60_000;

/** How far back the graph is read. Far more than any real history of merges. */
const GRAPH_LIMIT = 20_000;

/** Logins allowed to move `main`, overridable for another device's owner. */
export const allowedLogins = (env: NodeJS.ProcessEnv = process.env): string[] =>
  (env.MAIN_HISTORY_ALLOWED_LOGINS ?? 'llevasseur')
    .split(',')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * Error prefixes the route layer maps to status codes. They are values rather than bare
 * strings so a message and its status cannot drift apart.
 */
export const ERR = {
  /** The device's `gh` identity may not move `main`. */
  notAuthorized: 'not authorized:',
  /** The page was looking at an older `main` than origin has. */
  moved: 'main moved:',
  /** The request itself is wrong — an unknown target, a malformed body. */
  bad: 'bad request:',
  /** A preflight said no. */
  refused: 'sync refused:',
} as const;

const git = (repoDir: string, args: string[], timeout = GIT_TIMEOUT_MS) =>
  run('git', ['-C', repoDir, ...args], { timeout, maxBuffer: 32 * 1024 * 1024 });

/** Trimmed stdout, or null when the command failed — for probes where failure is an answer. */
async function gitOr(repoDir: string, args: string[]): Promise<string | null> {
  try {
    return (await git(repoDir, args)).stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `git`'s stderr is the useful half of a failure; the exit code says nothing. Kept short
 * so it can be shown on the page rather than only in a log.
 */
function gitFailure(err: unknown, fallback: string): string {
  const { stderr, message } = err as { stderr?: string; message?: string };
  const detail = ((stderr ?? '').trim() || (message ?? '').trim()).split('\n').slice(0, 4).join('; ');
  return detail || fallback;
}

/**
 * Bring `origin`'s `main` and every pin into this checkout's ref store.
 *
 * The refspecs are spelled out on the command line rather than configured, so this works
 * against a checkout nobody has set up. It writes refs and nothing else — no index, no
 * worktree, no checked-out file is touched, which is why it is safe to run behind a page
 * load in a repository somebody may be working in.
 */
export async function fetchMainHistory(repoDir: string): Promise<void> {
  await git(repoDir, [
    'fetch',
    '--no-tags',
    'origin',
    '+refs/heads/main:refs/remotes/origin/main',
    `+${MAIN_HISTORY_PREFIX}*:${MAIN_HISTORY_PREFIX}*`,
  ]);
}

/** What `origin/main` points at in this checkout's ref store, or null if it has no idea. */
export const readOriginMain = (repoDir: string): Promise<string | null> =>
  gitOr(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main']);

/** Every ref under `refs/main-history/` — pins and hidden markers together. */
export async function readMainHistoryRefs(repoDir: string): Promise<MainHistoryRef[]> {
  const out = await gitOr(repoDir, ['for-each-ref', '--format=%(objectname) %(refname)', MAIN_HISTORY_PREFIX]);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim().split(' '))
    .filter((parts): parts is [string, string] => parts.length === 2 && Boolean(parts[0]) && Boolean(parts[1]))
    .map(([sha, ref]) => ({ sha, ref }));
}

/**
 * The commit graph behind `main` and every pin.
 *
 * `--ignore-missing` matters: a pin can name a commit this checkout has not fetched yet,
 * and one unknown tip must not empty the whole graph.
 */
export async function readCommitGraph(repoDir: string, tips: readonly string[]): Promise<MainHistoryCommit[]> {
  if (tips.length === 0) return [];
  const out = await gitOr(repoDir, [
    'rev-list',
    '--parents',
    '--ignore-missing',
    `--max-count=${GRAPH_LIMIT}`,
    ...tips,
  ]);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim().split(' ').filter(Boolean))
    .filter((parts) => parts.length > 0)
    .map(([sha, ...parents]) => ({ sha: sha!, parents }));
}

/** The drawn graph: where `main` is, and every line kept beside it. */
export async function readMainHistory(repoDir: string, positions: readonly MainPosition[]): Promise<MainHistoryGraph> {
  const mainSha = (await readOriginMain(repoDir)) ?? '';
  const refs = await readMainHistoryRefs(repoDir);
  const tips = [mainSha, ...refs.map((r) => r.sha)].filter(Boolean);
  const commits = await readCommitGraph(repoDir, tips);
  return buildMainHistory({ mainSha, commits, positions, refs });
}

/**
 * The `gh` login this device acts as, checked against the allowlist.
 *
 * REST rather than GraphQL on purpose: `gh`'s GraphQL-backed calls resolve to an account
 * that is not a collaborator on these repositories, so `gh api user` is the identity that
 * actually matches the credential a push will use.
 *
 * The accepted limitation is that any local process sharing this device's token passes.
 * This gates the shared, remote half — moving `main` for everyone — not the local sync.
 */
export async function authorizeSlide(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const gh = findOnPath('gh', env);
  if (!gh) throw new Error(`${ERR.notAuthorized} the GitHub CLI is not installed on this device`);

  let login: string;
  try {
    const { stdout } = await run(gh, ['api', 'user'], { timeout: GIT_TIMEOUT_MS });
    login = String((JSON.parse(stdout) as { login?: unknown }).login ?? '');
  } catch (err) {
    throw new Error(`${ERR.notAuthorized} ${gitFailure(err, 'gh api user failed — run `gh auth login`')}`);
  }

  const allowed = allowedLogins(env);
  if (!login || !allowed.includes(login)) {
    throw new Error(
      `${ERR.notAuthorized} ${login || 'an unknown account'} may not move main (allowed: ${allowed.join(', ')})`,
    );
  }
  return login;
}

/**
 * Push using the same `gh` credential the allowlist was checked against.
 *
 * Injected per-invocation through `GIT_CONFIG_*` rather than written into the repository,
 * so nothing is left behind. It only bites on an https remote — an ssh remote authenticates
 * by key and ignores the helper entirely, in which case the allowlist check above is what
 * gates the action rather than the credential itself.
 */
const pushEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '!gh auth git-credential',
  GIT_TERMINAL_PROMPT: '0',
});

async function push(repoDir: string, args: string[]): Promise<void> {
  await run('git', ['-C', repoDir, 'push', ...args], {
    timeout: PUSH_TIMEOUT_MS,
    env: pushEnv(),
    maxBuffer: 8 * 1024 * 1024,
  });
}

export interface SlideResult {
  from: string;
  to: string;
  /** The pin written to keep the old position reachable, or null when one already did. */
  pinned: string | null;
  /** The `gh` login that was allowed to do it. */
  login: string;
}

/**
 * Move `origin/main` to `target`.
 *
 * Two things make this safe, in this order. The **pin goes first**: if the commit `main`
 * is leaving is not already reachable from some `refs/main-history/*` ref, it is pinned
 * and that push is confirmed before `main` is touched, so a failure between the two steps
 * leaves a redundant pin rather than a stranded commit. Then the move itself uses
 * `--force-with-lease` against the sha the page displayed, so a page that had gone stale
 * is rejected by GitHub atomically rather than by a check here that could race.
 */
export async function slideMain(
  repoDir: string,
  input: { expectedMain: unknown; target: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<SlideResult> {
  const expectedMain = typeof input.expectedMain === 'string' ? input.expectedMain.trim() : '';
  const target = typeof input.target === 'string' ? input.target.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(expectedMain)) throw new Error(`${ERR.bad} expectedMain must be a commit sha`);
  if (!/^[0-9a-f]{7,40}$/i.test(target)) throw new Error(`${ERR.bad} target must be a commit sha`);

  const login = await authorizeSlide(env);

  // Read origin fresh: sliding against a cached view would pin the wrong commit.
  await fetchMainHistory(repoDir);
  const from = await readOriginMain(repoDir);
  if (!from) throw new Error(`${ERR.bad} ${repoDir} has no origin/main to move`);
  if (!from.startsWith(expectedMain) && !expectedMain.startsWith(from)) {
    throw new Error(`${ERR.moved} origin/main is ${shortSha(from)}, the page was showing ${shortSha(expectedMain)}`);
  }
  if (from === target) throw new Error(`${ERR.bad} origin/main is already at ${shortSha(target)}`);

  const resolved = await gitOr(repoDir, ['rev-parse', '--verify', '--quiet', `${target}^{commit}`]);
  if (!resolved) throw new Error(`${ERR.bad} ${shortSha(target)} is not a commit in this repository`);

  const refs = await readMainHistoryRefs(repoDir);
  const commits = await readCommitGraph(repoDir, [from, resolved, ...refs.map((r) => r.sha)]);

  // The whole invariant, in one line: pin what main is about to leave behind.
  let pinned: string | null = null;
  if (needsPin(from, resolved, { commits, refs })) {
    pinned = pinRefFor(from);
    try {
      await push(repoDir, ['origin', `${from}:${pinned}`]);
    } catch (err) {
      throw new Error(
        `${ERR.refused} could not pin ${shortSha(from)} — main was not moved: ${gitFailure(err, 'push failed')}`,
      );
    }
  }

  try {
    await push(repoDir, [`--force-with-lease=refs/heads/main:${from}`, 'origin', `${resolved}:refs/heads/main`]);
  } catch (err) {
    const detail = gitFailure(err, 'push failed');
    if (/stale info|rejected/i.test(detail)) throw new Error(`${ERR.moved} origin rejected the move — ${detail}`);
    throw new Error(`${ERR.refused} ${detail}`);
  }

  // So the next read sees the move rather than the ~60s cache's idea of it.
  await fetchMainHistory(repoDir);
  return { from, to: resolved, pinned, login };
}

/**
 * Hide a line from the page, or show it again.
 *
 * Hiding writes a **separate** `hidden/` marker and never touches the pin, because
 * deleting the last ref to a line is exactly what would let GitHub collect those commits.
 * Showing again deletes only the marker — which holds nothing the pin does not.
 */
export async function setLineHidden(
  repoDir: string,
  input: { sha: unknown; hidden?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ref: string; hidden: boolean }> {
  const sha = typeof input.sha === 'string' ? input.sha.trim() : '';
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new Error(`${ERR.bad} sha must be a commit sha`);
  const hidden = input.hidden === undefined ? true : input.hidden === true;
  await authorizeSlide(env);

  const ref = hiddenRefFor(sha);
  // Belt and braces: this function must never be able to remove a pin.
  if (!ref.startsWith(`${MAIN_HISTORY_PREFIX}hidden/`)) throw new Error(`${ERR.bad} refusing to write ${ref}`);

  try {
    if (hidden) await push(repoDir, ['origin', `${sha}:${ref}`]);
    else await push(repoDir, ['origin', '--delete', ref]);
  } catch (err) {
    throw new Error(`${ERR.refused} ${gitFailure(err, 'push failed')}`);
  }
  await fetchMainHistory(repoDir);
  return { ref, hidden };
}

/** A named reason a local sync will not run. */
export interface SyncBlocker {
  reason: 'in-progress-operation' | 'main-in-other-worktree' | 'unpushed-commits';
  detail: string;
}

export interface LocalDivergence {
  repoDir: string;
  localMain: string | null;
  originMain: string | null;
  /** Local `main` is not the commit `origin/main` is. */
  diverged: boolean;
  /**
   * `origin/main` is an ancestor of local `main` — the case a plain `git pull` cannot fix,
   * because it reports "Already up to date" and leaves the checkout on the newer commit.
   */
  behind: boolean;
  /** Commits local `main` has that `origin/main` does not. */
  ahead: string[];
  /** Which of those no pin reaches — the ones a reset would actually lose. */
  unreferenced: string[];
  head: { branch: string | null; detached: boolean };
  /** What a sync would do, or null when it is blocked or unnecessary. */
  plan: 'branch-f' | 'stash-reset' | null;
  blockers: SyncBlocker[];
  /** True when the only thing standing in the way is work a sync can save first. */
  preservable: boolean;
}

/** The in-progress operations a reset must never run on top of. */
const IN_PROGRESS: Array<[string, string]> = [
  ['MERGE_HEAD', 'a merge is in progress'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'],
  ['REVERT_HEAD', 'a revert is in progress'],
  ['rebase-merge', 'a rebase is in progress'],
  ['rebase-apply', 'a rebase or `git am` is in progress'],
  ['BISECT_LOG', 'a bisect is in progress'],
];

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * The same path with every symlink resolved, so two spellings of one directory compare
 * equal. `git` reports the real path, while a caller may hold the symlinked one — on macOS
 * `/var/…` and `/private/var/…` are the same worktree, and comparing them raw would make
 * a repository look as though it had `main` checked out somewhere else.
 */
const realOrSelf = async (p: string): Promise<string> => {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
};

/** Worktrees of this repository that have `main` checked out, other than `repoDir` itself. */
async function otherMainWorktrees(repoDir: string): Promise<string[]> {
  const out = await gitOr(repoDir, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const here = await realOrSelf(repoDir);
  const found: string[] = [];
  let current: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    else if (line.trim() === 'branch refs/heads/main' && current && (await realOrSelf(current)) !== here) {
      found.push(current);
    }
  }
  return found;
}

/**
 * Whether this checkout's `main` still agrees with origin, and what it would take to fix
 * it. Every check here is deterministic and read-only — the button that acts on it should
 * never be the first thing to discover a reason it cannot.
 */
export async function readLocalDivergence(repoDir: string): Promise<LocalDivergence> {
  const [localMain, originMain, headBranch, gitDir] = await Promise.all([
    gitOr(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/heads/main']),
    readOriginMain(repoDir),
    gitOr(repoDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    gitOr(repoDir, ['rev-parse', '--absolute-git-dir']),
  ]);

  const diverged = Boolean(localMain && originMain && localMain !== originMain);
  const head = { branch: headBranch, detached: headBranch === null };

  const aheadOut = diverged ? await gitOr(repoDir, ['rev-list', 'refs/remotes/origin/main..refs/heads/main']) : null;
  const ahead = aheadOut ? aheadOut.split('\n').filter(Boolean) : [];
  const behind = diverged && ahead.length > 0;

  // A commit a pin reaches is not lost by a reset, so it is not a reason to refuse.
  const refs = await readMainHistoryRefs(repoDir);
  let unreferenced: string[] = [];
  if (ahead.length > 0 && refs.length > 0) {
    const held = new Set(
      (
        await readCommitGraph(
          repoDir,
          refs.map((r) => r.sha),
        )
      ).map((c) => c.sha),
    );
    unreferenced = ahead.filter((sha) => !held.has(sha));
  } else {
    unreferenced = ahead;
  }

  const blockers: SyncBlocker[] = [];
  if (gitDir) {
    for (const [entry, detail] of IN_PROGRESS) {
      if (await exists(path.join(gitDir, entry))) blockers.push({ reason: 'in-progress-operation', detail });
    }
  }
  for (const other of await otherMainWorktrees(repoDir)) {
    blockers.push({ reason: 'main-in-other-worktree', detail: `main is checked out at ${other}` });
  }
  if (unreferenced.length > 0) {
    blockers.push({
      reason: 'unpushed-commits',
      detail: `${unreferenced.length} commit${unreferenced.length === 1 ? '' : 's'} on local main that origin and every pin lack`,
    });
  }

  const preservable = blockers.length > 0 && blockers.every((b) => b.reason === 'unpushed-commits');
  const plan =
    !diverged || (blockers.length > 0 && !preservable) ? null : headBranch === 'main' ? 'stash-reset' : 'branch-f';

  return { repoDir, localMain, originMain, diverged, behind, ahead, unreferenced, head, blockers, plan, preservable };
}

export interface SyncLocalResult {
  from: string;
  to: string;
  /** Which path was taken. */
  plan: 'branch-f' | 'stash-reset';
  /**
   * The stash commit, when one was made. Surfaced so a fumbled `git stash drop` is
   * recoverable — the commit is still there under this sha.
   */
  stashSha: string | null;
  /** Where the position before the reset was recorded. */
  recorded: string;
  /** Where unpushed work was saved, when the caller asked to preserve it. */
  preservedAt: string | null;
  /** Whether that preservation ref reached origin, and why not if it did not. */
  preservedRemotely: boolean;
  note: string | null;
}

/** A message nothing else writes, so the stash this made is identifiable in a long list. */
const STASH_MESSAGE = 'claude-proxy main-history sync-local';

/**
 * Point this checkout's `main` at `origin/main`, however far back that is.
 *
 * `git pull` cannot do this: when `origin/main` has been slid backwards it is an ancestor
 * of the local branch, so pull reports "Already up to date" and the checkout silently
 * keeps the newer commit.
 *
 * The worktree is only touched when it has to be. With `main` checked out the work in
 * progress is stashed — `--include-untracked` and deliberately not `--all`, so ignored
 * `node_modules`, `.env` and `logs` stay exactly where they are — and only then reset.
 * With `HEAD` anywhere else the branch pointer is moved and no file changes at all.
 */
export async function syncLocal(
  repoDir: string,
  input: { preserve?: unknown } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<SyncLocalResult> {
  const preserve = input.preserve === true;
  const state = await readLocalDivergence(repoDir);
  if (!state.diverged) throw new Error(`${ERR.refused} local main already matches origin/main`);
  if (!state.localMain || !state.originMain) throw new Error(`${ERR.refused} this checkout has no main to move`);

  const hard = state.blockers.filter((b) => b.reason !== 'unpushed-commits');
  if (hard.length > 0) throw new Error(`${ERR.refused} ${hard.map((b) => b.detail).join('; ')}`);
  if (state.unreferenced.length > 0 && !preserve) {
    throw new Error(
      `${ERR.refused} ${state.unreferenced.length} unpushed commit(s) on local main are reachable from nothing else — re-send with preserve to save them first`,
    );
  }

  // Record where this checkout was before anything moves. Local first, so the position
  // survives even if the push below cannot run.
  const recorded = pinRefFor(state.localMain);
  await git(repoDir, ['update-ref', recorded, state.localMain]);

  let preservedAt: string | null = null;
  let preservedRemotely = false;
  let note: string | null = null;
  if (state.unreferenced.length > 0) {
    preservedAt = localOrphanRefFor(
      new Date()
        .toISOString()
        .replace(/[-:.]/g, '')
        .replace(/\d{3}Z$/, 'Z'),
    );
    await git(repoDir, ['update-ref', preservedAt, state.localMain]);
    try {
      // Best effort: the sync is deliberately not behind the slide's allowlist, so a
      // device that may not write to origin still gets the local ref rather than nothing.
      await authorizeSlide(env);
      await push(repoDir, ['origin', `${state.localMain}:${preservedAt}`]);
      preservedRemotely = true;
    } catch (err) {
      note = `kept locally only at ${preservedAt}: ${gitFailure(err, 'could not push it to origin')}`;
    }
  }

  let stashSha: string | null = null;
  const plan = state.plan ?? (state.head.branch === 'main' ? 'stash-reset' : 'branch-f');
  if (plan === 'stash-reset') {
    // A checkout can already hold stashes, and `stash push` makes none when there is
    // nothing to save — so the sha only counts as ours when the ref actually changed.
    const before = await gitOr(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/stash']);
    await git(repoDir, ['stash', 'push', '--include-untracked', '-m', STASH_MESSAGE]);
    const after = await gitOr(repoDir, ['rev-parse', '--verify', '--quiet', 'refs/stash']);
    stashSha = after && after !== before ? after : null;
    await git(repoDir, ['reset', '--hard', 'refs/remotes/origin/main']);
  } else {
    await git(repoDir, ['branch', '-f', 'main', 'refs/remotes/origin/main']);
  }

  return {
    from: state.localMain,
    to: state.originMain,
    plan,
    stashSha,
    recorded,
    preservedAt,
    preservedRemotely,
    note,
  };
}
