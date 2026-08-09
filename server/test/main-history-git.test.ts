// Moving `main` is the one thing here that can strand a commit, so it is tested against
// real git rather than a stub: a bare repository and its clones in a tmpdir, no network
// and no credentials. `gh` is a two-line script on PATH, which is enough because the only
// thing the code asks it is which login this device is.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hiddenRefFor, pinRefFor } from '@claude-proxy/core';
import { afterAll, describe, expect, it } from 'vitest';
import { ERR, readLocalDivergence, readMainHistory, setLineHidden, slideMain, syncLocal } from '../src/main-history.js';

const run = promisify(execFile);

/** Long enough for a clone and a handful of pushes on a slow machine. */
const TIMEOUT = 30_000;

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

const git = async (dir: string, ...args: string[]): Promise<string> =>
  (await run('git', ['-C', dir, ...args])).stdout.trim();

interface Fixture {
  origin: string;
  work: string;
  /** The four commits on `main`, oldest first. */
  shas: string[];
  /** A PATH carrying the stub `gh`, plus an allowlist that stub satisfies. */
  env: NodeJS.ProcessEnv;
}

/**
 * A bare origin with `main` at the fourth of four commits, and a clone that pushed them.
 *
 * Signing is turned off in the repository itself rather than in the environment, because
 * `git stash` writes a commit and would otherwise wait on this device's signing prompt.
 */
async function fixture(): Promise<Fixture> {
  // Realpath, because `git worktree list` reports `/private/var/…` for the `/var/…` the
  // tmpdir hands back, and one of these tests compares paths git printed with paths it built.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'main-history-')));
  roots.push(root);

  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  await run('git', ['init', '--bare', '-b', 'main', origin]);
  await run('git', ['init', '-b', 'main', work]);
  await git(work, 'config', 'user.name', 'Test');
  await git(work, 'config', 'user.email', 'test@example.invalid');
  await git(work, 'config', 'commit.gpgsign', 'false');

  const shas: string[] = [];
  for (const n of [1, 2, 3, 4]) {
    await writeFile(path.join(work, 'file.txt'), `commit ${n}\n`, 'utf8');
    await git(work, 'add', 'file.txt');
    await git(work, 'commit', '-m', `commit ${n}`);
    shas.push(await git(work, 'rev-parse', 'HEAD'));
  }
  await git(work, 'remote', 'add', 'origin', origin);
  await git(work, 'push', '-u', 'origin', 'main');

  const bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const gh = path.join(bin, 'gh');
  await writeFile(gh, '#!/bin/sh\nprintf \'{"login":"tester"}\\n\'\n', 'utf8');
  await chmod(gh, 0o755);

  return {
    origin,
    work,
    shas,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      MAIN_HISTORY_ALLOWED_LOGINS: 'tester',
    },
  };
}

/** What `origin`'s ref store holds, as `{ ref: sha }`. */
async function originRefs(origin: string): Promise<Record<string, string>> {
  const out = await git(origin, 'for-each-ref', '--format=%(refname) %(objectname)');
  const refs: Record<string, string> = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref, sha] = line.split(' ');
    if (ref && sha) refs[ref] = sha;
  }
  return refs;
}

describe('slideMain', () => {
  it(
    'pins the commit main leaves, and the orphans stay fetchable from a fresh clone',
    async () => {
      const { origin, work, shas, env } = await fixture();
      const [, b, c, d] = shas as [string, string, string, string];

      const result = await slideMain(work, { expectedMain: d, target: b }, env);
      expect(result).toMatchObject({ from: d, to: b, pinned: pinRefFor(d), login: 'tester' });

      const refs = await originRefs(origin);
      expect(refs['refs/heads/main']).toBe(b);
      expect(refs[pinRefFor(d)]).toBe(d);

      // The point of the pin: a clone that has never seen the old main can still get it.
      const fresh = path.join(path.dirname(origin), 'fresh');
      await run('git', ['clone', '--quiet', origin, fresh]);
      expect(await git(fresh, 'rev-parse', 'HEAD')).toBe(b);
      await git(fresh, 'fetch', '--no-tags', 'origin', '+refs/main-history/*:refs/main-history/*');
      expect(await git(fresh, 'cat-file', '-t', d)).toBe('commit');
      expect(await git(fresh, 'cat-file', '-t', c)).toBe('commit');
    },
    TIMEOUT,
  );

  it(
    'writes no pin when the new position already reaches the old one',
    async () => {
      const { work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];

      await slideMain(work, { expectedMain: d, target: b }, env);
      const forward = await slideMain(work, { expectedMain: b, target: d }, env);
      expect(forward.pinned).toBeNull();
    },
    TIMEOUT,
  );

  it(
    'writes no pin when an existing pin already reaches the old position',
    async () => {
      const { origin, work, shas, env } = await fixture();
      const [a, b, , d] = shas as [string, string, string, string];

      await slideMain(work, { expectedMain: d, target: b }, env);
      // b is reachable from the pin on d, so stepping back again strands nothing.
      const again = await slideMain(work, { expectedMain: b, target: a }, env);
      expect(again.pinned).toBeNull();

      const refs = await originRefs(origin);
      expect(refs['refs/heads/main']).toBe(a);
      expect(Object.keys(refs).filter((r) => r.startsWith('refs/main-history/'))).toEqual([pinRefFor(d)]);
    },
    TIMEOUT,
  );

  it(
    'refuses a stale expectedMain, an unknown target, and a login outside the allowlist',
    async () => {
      const { work, shas, env } = await fixture();
      const [a, b, , d] = shas as [string, string, string, string];

      await expect(slideMain(work, { expectedMain: a, target: b }, env)).rejects.toThrow(ERR.moved);
      await expect(slideMain(work, { expectedMain: d, target: 'f'.repeat(40) }, env)).rejects.toThrow(ERR.bad);
      await expect(slideMain(work, { expectedMain: d, target: d }, env)).rejects.toThrow(ERR.bad);
      await expect(
        slideMain(work, { expectedMain: d, target: b }, { ...env, MAIN_HISTORY_ALLOWED_LOGINS: 'someone-else' }),
      ).rejects.toThrow(ERR.notAuthorized);
    },
    TIMEOUT,
  );

  it(
    'the --force-with-lease form the slide pushes with is rejected on a stale sha',
    async () => {
      const { work, shas } = await fixture();
      const [a, b, , d] = shas as [string, string, string, string];

      // Exactly the push slideMain makes, with a lease naming a commit main is not on.
      // Nothing here checks the lease first, so this is git's own rejection.
      const stale = run('git', [
        '-C',
        work,
        'push',
        `--force-with-lease=refs/heads/main:${a}`,
        'origin',
        `${b}:refs/heads/main`,
      ]);
      await expect(stale).rejects.toThrow(/stale info|rejected/i);
      expect(await git(work, 'rev-parse', 'origin/main')).toBe(d);
    },
    TIMEOUT,
  );
});

describe('setLineHidden', () => {
  it(
    'hides a line without touching its pin, and shows it again by deleting only the marker',
    async () => {
      const { origin, work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);

      const hide = await setLineHidden(work, { sha: d, hidden: true }, env);
      expect(hide).toEqual({ ref: hiddenRefFor(d), hidden: true });
      let refs = await originRefs(origin);
      expect(refs[hiddenRefFor(d)]).toBe(d);
      expect(refs[pinRefFor(d)]).toBe(d);

      await setLineHidden(work, { sha: d, hidden: false }, env);
      refs = await originRefs(origin);
      expect(refs[hiddenRefFor(d)]).toBeUndefined();
      // Un-hiding must never be the thing that lets the commits go.
      expect(refs[pinRefFor(d)]).toBe(d);
    },
    TIMEOUT,
  );
});

describe('readMainHistory', () => {
  it(
    'draws main where origin has it, with the slid-off commits in their own lane',
    async () => {
      const { work, shas, env } = await fixture();
      const [a, b, c, d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);

      const positions = [a, b, c, d].map((sha, i) => ({
        sha,
        prNumber: i + 1,
        mergedAt: `2026-08-0${i + 1}T00:00:00Z`,
      }));
      const graph = await readMainHistory(work, positions);

      expect(graph.mainSha).toBe(b);
      expect(graph.mainPr).toBe(2);
      expect(graph.rows.find((r) => r.sha === b)?.isMain).toBe(true);
      expect(graph.rows.find((r) => r.sha === d)?.onMain).toBe(false);
      expect(graph.lanes.map((l) => l.tip)).toEqual([d]);
      expect(graph.lanes[0]?.divergesFrom).toBe(b);
    },
    TIMEOUT,
  );
});

describe('readLocalDivergence and syncLocal', () => {
  it(
    'moves the branch pointer and leaves the worktree alone when HEAD is elsewhere',
    async () => {
      const { work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);
      await git(work, 'checkout', '--quiet', '-b', 'side');

      const before = await readLocalDivergence(work);
      expect(before).toMatchObject({ diverged: true, behind: true, plan: 'branch-f', blockers: [] });
      // The commits ahead are held by the pin, so none of them counts as unreferenced.
      expect(before.ahead).toHaveLength(2);
      expect(before.unreferenced).toEqual([]);

      const result = await syncLocal(work, {}, env);
      expect(result).toMatchObject({ from: d, to: b, plan: 'branch-f', stashSha: null, recorded: pinRefFor(d) });
      expect(await git(work, 'rev-parse', 'refs/heads/main')).toBe(b);
      // `side` is still on the fourth commit, and the file with it.
      expect(await git(work, 'rev-parse', 'HEAD')).toBe(d);
      expect(await readFile(path.join(work, 'file.txt'), 'utf8')).toBe('commit 4\n');
    },
    TIMEOUT,
  );

  it(
    'stashes the work in progress and reports the stash commit when main is checked out',
    async () => {
      const { work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);
      await writeFile(path.join(work, 'file.txt'), 'uncommitted\n', 'utf8');

      const result = await syncLocal(work, {}, env);
      expect(result.plan).toBe('stash-reset');
      expect(result.stashSha).toMatch(/^[0-9a-f]{40}$/);
      expect(await git(work, 'rev-parse', 'refs/heads/main')).toBe(b);
      expect(await readFile(path.join(work, 'file.txt'), 'utf8')).toBe('commit 2\n');
      // Surfaced so a fumbled `stash drop` is not fatal — the commit is still reachable.
      expect(await git(work, 'cat-file', '-t', result.stashSha!)).toBe('commit');
      expect(await git(work, 'stash', 'list')).toContain('claude-proxy main-history sync-local');
      expect(await git(work, 'rev-parse', result.recorded)).toBe(d);
    },
    TIMEOUT,
  );

  it(
    'refuses while an operation is in progress',
    async () => {
      const { work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);
      await writeFile(path.join(work, '.git', 'MERGE_HEAD'), `${d}\n`, 'utf8');

      const state = await readLocalDivergence(work);
      expect(state.plan).toBeNull();
      expect(state.blockers).toContainEqual({ reason: 'in-progress-operation', detail: 'a merge is in progress' });
      await expect(syncLocal(work, {}, env)).rejects.toThrow(/a merge is in progress/);
      // Refusing means refusing: main is untouched.
      expect(await git(work, 'rev-parse', 'refs/heads/main')).toBe(d);
    },
    TIMEOUT,
  );

  it(
    'refuses, and names the path, when main is checked out in another worktree',
    async () => {
      const { work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);

      const other = path.join(path.dirname(work), 'other');
      await git(work, 'checkout', '--quiet', '--detach');
      await git(work, 'worktree', 'add', '--quiet', other, 'main');

      const state = await readLocalDivergence(work);
      expect(state.plan).toBeNull();
      expect(state.blockers).toContainEqual({
        reason: 'main-in-other-worktree',
        detail: `main is checked out at ${other}`,
      });
      await expect(syncLocal(work, {}, env)).rejects.toThrow(/main is checked out at/);
    },
    TIMEOUT,
  );

  it(
    'refuses unpushed commits nothing else reaches, and preserves them when told to',
    async () => {
      const { origin, work, shas, env } = await fixture();
      const [, b, , d] = shas as [string, string, string, string];
      await slideMain(work, { expectedMain: d, target: b }, env);
      // A local commit on top of the old main: on no pin, and not on origin.
      await git(work, 'commit', '--allow-empty', '-m', 'local only');
      const local = await git(work, 'rev-parse', 'HEAD');

      const state = await readLocalDivergence(work);
      expect(state.unreferenced).toEqual([local]);
      expect(state.preservable).toBe(true);
      await expect(syncLocal(work, {}, env)).rejects.toThrow(ERR.refused);
      expect(await git(work, 'rev-parse', 'refs/heads/main')).toBe(local);

      const result = await syncLocal(work, { preserve: true }, env);
      expect(result.preservedAt).toMatch(/^refs\/main-history\/local-orphan\//);
      expect(await git(work, 'rev-parse', result.preservedAt!)).toBe(local);
      expect(await git(work, 'rev-parse', 'refs/heads/main')).toBe(b);
      expect(result.preservedRemotely).toBe(true);
      expect((await originRefs(origin))[result.preservedAt!]).toBe(local);
      expect(await git(work, 'rev-parse', result.recorded)).toBe(local);
    },
    TIMEOUT,
  );
});
