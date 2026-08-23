// The verdict itself is unit-tested in core; what is checked here is the wiring — that
// the builders read a real transcript's mtime, that the parent's link is what settles a
// finished subagent, and that a job inherits its whole family's verdict.
import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { QUIET_AFTER_MS } from '@claude-proxy/core';
import { describe, expect, it } from 'vitest';
import { buildJobs, buildSessionsGraph, buildSessionsLiveness } from '../src/api.js';

const SESSION = 'be4b71b3-ccaf-4350-b1aa-b0cf0218897a';
const NOW = new Date('2026-08-07T12:00:00.000Z');
const PARENT = 'aaaaaaaaaaaaaaaa';
const CHILD = 'bbbbbbbbbbbbbbbb';
const OLD = 'cccccccccccccccc';

/** An ISO stamp `ms` before `NOW`. */
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function transcript(threadId: string, started: string, lines: string[]): string {
  return [
    `# Session ${threadId}`,
    '- model: claude-opus-5',
    `- session: ${SESSION}`,
    `- started: ${started}`,
    '',
    ...lines,
    '',
  ].join('\n');
}

/**
 * A corpus with all three verdicts in it:
 *
 * - `PARENT` spawned a subagent and has not stepped past the spawn, and its transcript
 *   was appended to a minute ago — the case the whole feature exists for.
 * - `CHILD` ends on a tool call, as every subagent does, but its parent never recorded a
 *   return, and it has been silent for far longer than the threshold.
 * - `OLD` handed back hours ago.
 */
async function corpus(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'liveness-'));
  const sessions = path.join(dir, 'sessions');
  await mkdir(sessions, { recursive: true });

  const write = async (threadId: string, body: string, modified: Date) => {
    const file = path.join(sessions, `${threadId}.md`);
    await writeFile(file, body);
    await utimes(file, modified, modified);
  };

  await write(
    PARENT,
    transcript(PARENT, '2026-08-07T11:00:00.000Z', [
      '## Task: Ship the liveness verdict',
      '- Agent(subagent_type=Explore, description=sweep the routes)',
    ]),
    ago(60_000),
  );
  await write(
    CHILD,
    transcript(CHILD, '2026-08-07T11:05:00.000Z', ['## Task: sweep the routes', '- Bash(command=pnpm verify)']),
    ago(QUIET_AFTER_MS * 3),
  );
  await write(
    OLD,
    transcript(OLD, '2026-08-07T04:00:00.000Z', [
      '## Task: something else',
      '- Bash(command=ls)',
      '- done: shipped it',
    ]),
    ago(8 * 60 * 60_000),
  );

  return dir;
}

/** One job directory whose `state.json` claims the session the corpus above wrote. */
async function jobsFor(sessionId: string | null): Promise<string> {
  const jobsDir = await mkdtemp(path.join(tmpdir(), 'liveness-jobs-'));
  const job = path.join(jobsDir, 'aaaa1111');
  await mkdir(job, { recursive: true });
  const state = {
    state: 'working',
    detail: 'still at it',
    name: 'the run',
    cwd: '/Users/me/app',
    createdAt: '2026-08-07T11:00:00.000Z',
    updatedAt: '2026-08-07T11:59:00.000Z',
  };
  const body = sessionId === null ? state : { ...state, sessionId };
  await writeFile(path.join(job, 'state.json'), JSON.stringify(body), 'utf8');
  return jobsDir;
}

describe('buildSessionsGraph liveness', () => {
  it('reads a just-appended branch as running and a long-silent one as quiet', async () => {
    const { sessions } = await buildSessionsGraph(await corpus(), NOW);
    const by = new Map(sessions.map((s) => [s.threadId, s]));

    expect(by.get(PARENT)?.liveness.state).toBe('running');
    expect(by.get(PARENT)?.liveness.idleMs).toBe(60_000);
    // Quiet, not dead: nothing here says the branch stopped, only that it went silent.
    expect(by.get(CHILD)?.liveness.state).toBe('quiet');
    expect(by.get(CHILD)?.liveness.terminal).toBe(false);
    expect(by.get(OLD)?.liveness.state).toBe('finished');
  });

  it('serves a thin index: step counts in place of node streams', async () => {
    const { sessions } = await buildSessionsGraph(await corpus(), NOW);
    const by = new Map(sessions.map((s) => [s.threadId, s]));

    expect(by.get(PARENT)?.steps).toBe(2);
    expect(by.get(PARENT)).not.toHaveProperty('nodes');
  });

  it('is a pure function of `now`, so two reads of one corpus agree', async () => {
    const dir = await corpus();
    const a = await buildSessionsGraph(dir, NOW);
    const b = await buildSessionsGraph(dir, NOW);
    expect(a).toEqual(b);
  });

  it('states the threshold it judged against', async () => {
    const { sessions } = await buildSessionsGraph(await corpus(), NOW);
    expect(sessions[0]?.liveness.quietAfterMs).toBe(QUIET_AFTER_MS);
  });
});

describe('buildSessionsLiveness', () => {
  it('lists every branch live-first, with counts and no node streams', async () => {
    const { threads, meta } = await buildSessionsLiveness(await corpus(), NOW);

    expect(threads.map((t) => t.threadId)).toEqual([PARENT, CHILD, OLD]);
    expect(meta.total).toBe(3);
    expect(meta.running).toBe(1);
    expect(meta.quiet).toBe(1);
    expect(meta.finished).toBe(1);
    expect(meta.at).toBe(NOW.toISOString());
    expect(meta.quietAfterMs).toBe(QUIET_AFTER_MS);
    // Steps are a count, so the payload stays cheap enough to poll from a shell loop.
    expect(threads[0]?.steps).toBeGreaterThan(0);
    expect(threads[0]).not.toHaveProperty('nodes');
  });

  it('carries the spawn tree, so a dispatcher can tell which branch is which', async () => {
    const { threads } = await buildSessionsLiveness(await corpus(), NOW);
    const child = threads.find((t) => t.threadId === CHILD);
    expect(child?.parentThreadId).toBe(PARENT);
    expect(child?.agentType).toBe('Explore');
    expect(child?.depth).toBe(1);
  });
});

describe('buildJobs liveness', () => {
  it("rolls the session's whole family up, and one live branch makes the job live", async () => {
    const logDir = await corpus();
    const { jobs, meta } = await buildJobs(await jobsFor(SESSION), logDir, NOW);

    expect(jobs[0]?.threads).toBe(3);
    expect(jobs[0]?.liveness.state).toBe('running');
    expect(meta.live).toBe(1);
  });

  it('is unknown when no transcript matched — no match is not evidence the job stopped', async () => {
    const logDir = await corpus();
    const { jobs, meta } = await buildJobs(await jobsFor(null), logDir, NOW);

    expect(jobs[0]?.threads).toBe(0);
    expect(jobs[0]?.liveness.state).toBe('unknown');
    // The job still claims `working`; only the derived verdict withholds judgement.
    expect(meta.running).toBe(1);
    expect(meta.live).toBe(0);
  });
});
