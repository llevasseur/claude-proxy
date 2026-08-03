import { access, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { deleteJob, listJobs, readJob, readJobFile, resolveJobsDir } from '../src/jobs.js';

let jobsDir: string;
/** A directory outside the jobs root, for the escape attempts to aim at. */
let outside: string;

const STATE = {
  state: 'working',
  detail: 'doing the thing',
  name: 'a named job',
  nameSource: 'user',
  cwd: '/Users/me/app',
  respawnFlags: ['--agent', 'claude', '--model', 'opus[1m]'],
  createdAt: '2026-07-28T17:33:13.669Z',
  updatedAt: '2026-07-28T17:33:22.788Z',
};

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'jobs-test-'));
  jobsDir = path.join(root, 'jobs');
  outside = path.join(root, 'outside');
  await mkdir(jobsDir, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'not yours', 'utf8');

  // A live job: state, timeline, and a tmp/ holding work.
  const live = path.join(jobsDir, 'aaaa1111');
  await mkdir(path.join(live, 'tmp', 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(live, 'state.json'), JSON.stringify(STATE), 'utf8');
  await writeFile(path.join(live, 'timeline.jsonl'), `${JSON.stringify({ at: STATE.updatedAt, state: 'working' })}\n`);
  await writeFile(path.join(live, 'tmp', 'check.mjs'), 'const a = 1;\n', 'utf8');
  await writeFile(path.join(live, 'tmp', 'node_modules', 'dep', 'index.js'), 'module.exports = 1;\n', 'utf8');
  await writeFile(path.join(live, 'tmp', 'shot.bin'), Buffer.from([0x89, 0x00, 0x01, 0x02]));
  await symlink(path.join(outside, 'secret.txt'), path.join(live, 'tmp', 'escape.txt'));

  // A husk: the directory outlived its job, so there is no state.json.
  const husk = path.join(jobsDir, 'bbbb2222');
  await mkdir(path.join(husk, 'tmp'), { recursive: true });
  await writeFile(path.join(husk, 'tmp', 'leftover.log'), 'old output\n', 'utf8');
});

describe('resolveJobsDir', () => {
  it('defaults to ~/.claude/jobs and honours CLAUDE_JOBS', () => {
    expect(resolveJobsDir({})).toMatch(/\.claude[/\\]jobs$/);
    expect(resolveJobsDir({ CLAUDE_JOBS: '/tmp/elsewhere' })).toBe(path.resolve('/tmp/elsewhere'));
  });
});

describe('listJobs', () => {
  it('lists every job directory with its state and on-disk counts', async () => {
    const jobs = await listJobs(jobsDir);
    expect(jobs.map((j) => j.id).sort()).toEqual(['aaaa1111', 'bbbb2222']);

    const live = jobs.find((j) => j.id === 'aaaa1111');
    expect(live?.stateReadable).toBe(true);
    expect(live?.state).toBe('working');
    expect(live?.name).toBe('a named job');
    expect(live?.model).toBe('opus[1m]');
    // state.json, timeline.jsonl, tmp/check.mjs, tmp/shot.bin, the symlink — but
    // nothing under node_modules, which is listed and not descended into.
    expect(live?.files).toBe(5);
    expect(live?.bytes).toBeGreaterThan(0);
  });

  it('still lists a husk, flagging that its state is unreadable', async () => {
    const husk = (await listJobs(jobsDir)).find((j) => j.id === 'bbbb2222');
    expect(husk?.stateReadable).toBe(false);
    expect(husk?.state).toBe('');
    expect(husk?.files).toBe(1);
    // With no state to date it, activity falls back to the newest file on disk.
    expect(husk?.activity).not.toBe('');
  });

  it('sorts newest activity first', async () => {
    const jobs = await listJobs(jobsDir);
    const activities = jobs.map((j) => j.activity);
    expect([...activities].sort().reverse()).toEqual(activities);
  });

  it('throws a labelled error when the jobs root cannot be read', async () => {
    await expect(listJobs(path.join(jobsDir, 'nope'))).rejects.toThrow(/cannot read jobs directory/);
  });
});

describe('readJob', () => {
  it('returns the job plus its folder tree, directories first', async () => {
    const { job, tree } = await readJob(jobsDir, 'aaaa1111');
    expect(job.id).toBe('aaaa1111');
    expect(tree.tree.map((n) => n.name)).toEqual(['tmp', 'state.json', 'timeline.jsonl']);
    expect(tree.truncated).toBe(false);
  });

  it('lists a dependency directory without descending into it', async () => {
    const { tree } = await readJob(jobsDir, 'aaaa1111');
    const nodeModules = tree.tree.find((n) => n.name === 'tmp')?.children.find((n) => n.name === 'node_modules');
    expect(nodeModules?.dir).toBe(true);
    expect(nodeModules?.skipped).toBe(true);
    expect(nodeModules?.children).toEqual([]);
  });

  it('marks a symlink rather than following it', async () => {
    const { tree } = await readJob(jobsDir, 'aaaa1111');
    const link = tree.tree.find((n) => n.name === 'tmp')?.children.find((n) => n.name === 'escape.txt');
    expect(link?.link).toBe(true);
  });

  it('rejects an id that could escape the jobs root', async () => {
    for (const id of ['../outside', 'a/b', '..', '']) {
      await expect(readJob(jobsDir, id)).rejects.toThrow(/invalid job id/);
    }
  });

  it("404s a job directory that isn't there", async () => {
    await expect(readJob(jobsDir, 'cccc3333')).rejects.toThrow(/job not found/);
  });
});

describe('readJobFile', () => {
  it('reads a text file with its kind and metadata', async () => {
    const file = await readJobFile(jobsDir, 'aaaa1111', 'state.json');
    expect(file.kind).toBe('json');
    expect(file.encoding).toBe('utf8');
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(JSON.parse(file.content).state).toBe('working');
  });

  it('reads a nested file', async () => {
    const file = await readJobFile(jobsDir, 'aaaa1111', 'tmp/check.mjs');
    expect(file.kind).toBe('code');
    expect(file.content).toBe('const a = 1;\n');
  });

  it('reports a file whose bytes are binary without reading it out', async () => {
    const file = await readJobFile(jobsDir, 'aaaa1111', 'tmp/shot.bin');
    expect(file.binary).toBe(true);
    expect(file.kind).toBe('binary');
    expect(file.content).toBe('');
    expect(file.note).toMatch(/binary/);
  });

  it('refuses a path that climbs out of the job directory', async () => {
    for (const rel of ['../bbbb2222/tmp/leftover.log', '../../outside/secret.txt', 'tmp/../../x', './state.json', '']) {
      await expect(readJobFile(jobsDir, 'aaaa1111', rel)).rejects.toThrow(/invalid job file path/);
    }
  });

  it('refuses to read through a symlink pointing outside the job', async () => {
    await expect(readJobFile(jobsDir, 'aaaa1111', 'tmp/escape.txt')).rejects.toThrow(/invalid job file path/);
  });

  it("refuses a directory, and 404s a file that isn't there", async () => {
    await expect(readJobFile(jobsDir, 'aaaa1111', 'tmp')).rejects.toThrow(/job file is a directory/);
    await expect(readJobFile(jobsDir, 'aaaa1111', 'missing.txt')).rejects.toThrow(/job file not found/);
  });

  it('rejects a bad job id before touching disk', async () => {
    await expect(readJobFile(jobsDir, '../outside', 'secret.txt')).rejects.toThrow(/invalid job id/);
  });
});

/** True when the path is still on disk. */
async function exists(target: string): Promise<boolean> {
  return access(target).then(
    () => true,
    () => false,
  );
}

describe('deleteJob', () => {
  /** A throwaway jobs root per test: these mutate the disk, so nothing is shared. */
  async function fixture(): Promise<{ root: string; jobs: string; outside: string }> {
    const root = await mkdtemp(path.join(tmpdir(), 'jobs-delete-'));
    const jobs = path.join(root, 'jobs');
    const outside = path.join(root, 'outside');
    await mkdir(jobs, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'keep.txt'), 'still here', 'utf8');

    const done = path.join(jobs, 'dddd4444');
    await mkdir(path.join(done, 'tmp'), { recursive: true });
    await writeFile(path.join(done, 'state.json'), JSON.stringify({ ...STATE, state: 'done' }), 'utf8');
    await writeFile(path.join(done, 'tmp', 'out.log'), 'finished\n', 'utf8');

    const running = path.join(jobs, 'eeee5555');
    await mkdir(running, { recursive: true });
    await writeFile(path.join(running, 'state.json'), JSON.stringify(STATE), 'utf8');

    const husk = path.join(jobs, 'ffff6666');
    await mkdir(husk, { recursive: true });
    await writeFile(path.join(husk, 'leftover.log'), 'old output\n', 'utf8');

    return { root, jobs, outside };
  }

  it('removes the directory and everything under it, reporting what went', async () => {
    const { jobs } = await fixture();
    const result = await deleteJob(jobs, 'dddd4444');

    expect(result.id).toBe('dddd4444');
    expect(result.name).toBe('a named job');
    expect(result.state).toBe('done');
    expect(result.files).toBe(2); // state.json + tmp/out.log
    expect(result.bytes).toBeGreaterThan(0);
    expect(await exists(path.join(jobs, 'dddd4444'))).toBe(false);
    expect((await listJobs(jobs)).map((j) => j.id).sort()).toEqual(['eeee5555', 'ffff6666']);
  });

  it('deletes a husk, which is the whole point of the control', async () => {
    const { jobs } = await fixture();
    const result = await deleteJob(jobs, 'ffff6666');
    expect(result.files).toBe(1);
    expect(result.state).toBe('');
    expect(await exists(path.join(jobs, 'ffff6666'))).toBe(false);
  });

  it('refuses a job that is still running, leaving it on disk', async () => {
    const { jobs } = await fixture();
    await expect(deleteJob(jobs, 'eeee5555')).rejects.toThrow(/job is still running/);
    expect(await exists(path.join(jobs, 'eeee5555'))).toBe(true);
  });

  it('refuses a symlinked job directory rather than following it', async () => {
    const { jobs, outside } = await fixture();
    await symlink(outside, path.join(jobs, 'gggg7777'));
    await expect(deleteJob(jobs, 'gggg7777')).rejects.toThrow(/symlink/);
    expect(await exists(path.join(outside, 'keep.txt'))).toBe(true);
    expect(await exists(path.join(jobs, 'gggg7777'))).toBe(true);
  });

  it('rejects an id that could escape the jobs root, before touching disk', async () => {
    const { jobs, outside } = await fixture();
    for (const id of ['../outside', 'a/b', '..', '']) {
      await expect(deleteJob(jobs, id)).rejects.toThrow(/invalid job id/);
    }
    expect(await exists(outside)).toBe(true);
  });

  it("404s a job directory that isn't there", async () => {
    const { jobs } = await fixture();
    await expect(deleteJob(jobs, 'hhhh8888')).rejects.toThrow(/job not found/);
  });
});
