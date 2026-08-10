/**
 * The slug lookup is the one part of the pull requests read that depends on how a
 * *device* spelled its remote, so these drive it over throwaway repos rather than over
 * this checkout — whose own `origin` is an ssh alias and would prove only this machine.
 *
 * Two things are deliberately kept out. `ssh -G` is never exercised: it answers from the
 * device's real `~/.ssh/config`, so a test over it would pass or fail per machine, and
 * the alias case is covered purely in `packages/core` through `extraHosts`. And `gh` is
 * pointed at a path that cannot execute, so the last layer always declines and no test
 * reaches the network.
 */
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveSlug } from '../src/github.js';

const run = promisify(execFile);

/** A `gh` that cannot run, so layer four declines instead of calling GitHub. */
const NO_GH = path.join(tmpdir(), 'claude-proxy-no-such-gh');

/** An empty repository carrying nothing but the remote — and config — under test. */
async function repoWith(remote: string | null, config: string[][] = []): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'github-remote-'));
  await run('git', ['-C', dir, 'init', '--quiet']);
  for (const args of config) await run('git', ['-C', dir, 'config', ...args]);
  if (remote) await run('git', ['-C', dir, 'remote', 'add', 'origin', remote]);
  return dir;
}

describe('resolveSlug', () => {
  it('takes REPO_SLUG over anything the checkout says', async () => {
    const dir = await repoWith('https://gitlab.com/wrong/repo.git');
    expect(await resolveSlug(NO_GH, dir, { REPO_SLUG: 'llevasseur/claude-proxy' })).toEqual({
      slug: 'llevasseur/claude-proxy',
      detail: 'REPO_SLUG',
    });
  });

  it('says so when REPO_SLUG is not owner/name', async () => {
    const dir = await repoWith('https://github.com/o/r.git');
    const { slug, detail } = await resolveSlug(NO_GH, dir, { REPO_SLUG: 'https://github.com/o/r' });
    expect(slug).toBeNull();
    expect(detail).toContain('REPO_SLUG');
  });

  it('reads a plain GitHub remote', async () => {
    const dir = await repoWith('https://github.com/llevasseur/claude-proxy.git');
    expect(await resolveSlug(NO_GH, dir, {})).toEqual({ slug: 'llevasseur/claude-proxy', detail: 'github.com' });
  });

  it('reads a remote only an insteadOf rewrite makes GitHub', async () => {
    // `git remote get-url` would answer `gh:llevasseur/claude-proxy.git`, whose host is
    // `gh` — so a `github.com` detail is only reachable through `ls-remote --get-url`.
    const dir = await repoWith('gh:llevasseur/claude-proxy.git', [['url.https://github.com/.insteadOf', 'gh:']]);
    expect(await resolveSlug(NO_GH, dir, {})).toEqual({ slug: 'llevasseur/claude-proxy', detail: 'github.com' });
  });

  it('accepts an Enterprise host named by GH_HOST', async () => {
    const dir = await repoWith('https://github.acme.internal/o/r.git');
    expect(await resolveSlug(NO_GH, dir, { GH_HOST: 'github.acme.internal' })).toEqual({
      slug: 'o/r',
      detail: 'github.acme.internal',
    });
  });

  it('names the remote it could not read', async () => {
    const dir = await repoWith('https://gitlab.com/o/r.git');
    const { slug, detail } = await resolveSlug(NO_GH, dir, {});
    expect(slug).toBeNull();
    expect(detail).toContain('https://gitlab.com/o/r.git');
  });

  it('says when there is no origin at all', async () => {
    const dir = await repoWith(null);
    expect(await resolveSlug(NO_GH, dir, {})).toEqual({ slug: null, detail: '`origin` is not set' });
  });
});
