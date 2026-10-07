import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAbTrial, buildAbTrials, deleteAbTrial } from '../src/ab-trials.js';
import { ingestJevCalls } from '../src/db/ingest-jev.js';
import { openDb } from '../src/db/open.js';

/**
 * The `/ab` trials page's reads and its delete.
 *
 * The claims that matter: the list groups by command with the judge's agreement counted,
 * a trial's full outputs come from its record rather than the database, a key that could
 * leave the keep is refused, and a delete removes the record so no later ingest brings
 * the trial back.
 */

let logDir: string;
let keep: string;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'ab-logs-'));
  keep = await mkdtemp(path.join(tmpdir(), 'ab-keep-'));
});

afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
  await rm(keep, { recursive: true, force: true });
});

interface LabelOptions {
  command: string;
  recordedAt: string;
  verdict: 'a' | 'b' | 'tie';
  pick?: 'a' | 'b' | 'tie';
}

/** One label run as the recorder writes it: its own directory, a `kind: "ab"` session, one record. */
async function writeLabel(session: string, opts: LabelOptions): Promise<void> {
  const dir = path.join(keep, session);
  await mkdir(dir, { recursive: true });
  const at = opts.recordedAt;
  await writeFile(
    path.join(dir, 'session.json'),
    JSON.stringify({ v: 1, session, kind: 'ab', startedAt: at, endedAt: at, recorded: 1 }),
    'utf8',
  );
  const record = {
    v: 1,
    id: 1,
    session,
    kind: 'ab',
    recordedAt: at,
    trial: {
      command: opts.command,
      args: '--draft',
      mode: 'worktree',
      fixture: { branch: 'feat/fixture-app', sha: '5237' },
      rubric: 'Which output is better?',
      versions: { a: { ref: 'a.md', lines: 150 }, b: { ref: 'b.md', lines: 13 } },
      runs: {
        a: { output: '## Output A', title: 'A title', tokens: 100, durationMs: 2000, toolUses: 3, prs: [12] },
        b: { output: '## Output B', title: 'B title', tokens: 80, durationMs: 1500, toolUses: 2, skipped: ['publish'] },
      },
      judge: { shownFirst: 'b', verdict: opts.verdict, confidence: 'high', reasons: ['one', 'two'] },
      pick: opts.pick ?? null,
    },
    label: { pick: opts.pick ?? null, by: 'human' },
  };
  await writeFile(path.join(dir, '000001.json'), JSON.stringify(record), 'utf8');
}

async function ingest(): Promise<void> {
  const db = openDb(logDir);
  try {
    await ingestJevCalls(db, keep);
  } finally {
    db.close();
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

describe('buildAbTrials', () => {
  it('answers empty, without a substrate, when there is no database', () => {
    expect(buildAbTrials(path.join(logDir, 'nowhere'))).toEqual({
      trials: [],
      commands: [],
      meta: { substrate: false },
    });
  });

  it('lists newest first and tallies each command', async () => {
    await writeLabel('20261007T100000-aaaaaa', {
      command: 'pr',
      recordedAt: '2026-10-07T10:00:00.000Z',
      verdict: 'b',
      pick: 'b',
    });
    await writeLabel('20261007T110000-bbbbbb', {
      command: '/pr',
      recordedAt: '2026-10-07T11:00:00.000Z',
      verdict: 'a',
      pick: 'b',
    });
    await writeLabel('20261007T120000-cccccc', {
      command: 'task',
      recordedAt: '2026-10-07T12:00:00.000Z',
      verdict: 'tie',
    });
    await ingest();

    const answer = buildAbTrials(logDir);
    expect(answer.meta.substrate).toBe(true);
    expect(answer.trials.map((t) => t.session)).toEqual([
      '20261007T120000-cccccc',
      '20261007T110000-bbbbbb',
      '20261007T100000-aaaaaa',
    ]);
    // `/pr` and `pr` are one command.
    expect(answer.commands).toEqual([
      { command: 'task', trials: 1, picked: 0, agreed: 0 },
      { command: 'pr', trials: 2, picked: 2, agreed: 1 },
    ]);
    const [unpicked, disagreed, agreed] = answer.trials;
    expect(unpicked).toMatchObject({ pick: null, agrees: null, verdict: 'tie' });
    expect(disagreed).toMatchObject({ pick: 'b', verdict: 'a', agrees: false });
    expect(agreed).toMatchObject({ agrees: true, setup: 'feat/fixture-app', args: '--draft' });
    expect(agreed?.runs.a).toEqual({ tokens: 100, durationMs: 2000, toolUses: 3 });
  });
});

describe('buildAbTrial', () => {
  it('reads both full outputs and the judge from the record', async () => {
    await writeLabel('20261007T100000-aaaaaa', {
      command: 'pr',
      recordedAt: '2026-10-07T10:00:00.000Z',
      verdict: 'b',
      pick: 'a',
    });

    const answer = await buildAbTrial(keep, '20261007T100000-aaaaaa', '1');
    expect(answer.runs.a).toMatchObject({ output: '## Output A', title: 'A title', prs: ['#12'] });
    expect(answer.runs.b).toMatchObject({ output: '## Output B', skipped: ['publish'] });
    expect(answer.judge).toEqual({ shownFirst: 'b', verdict: 'b', confidence: 'high', reasons: ['one', 'two'] });
    expect(answer.trial).toMatchObject({ pick: 'a', agrees: false });
    expect(answer.pickBy).toBe('human');
    expect(answer.versions.b).toEqual({ ref: 'b.md', lines: 13 });
  });

  it('refuses a key that could leave the keep, and 404s one that is not there', async () => {
    await expect(buildAbTrial(keep, '../etc', '1')).rejects.toThrow(/^invalid trial/);
    await expect(buildAbTrial(keep, '20261007T100000-aaaaaa', 'x')).rejects.toThrow(/^invalid trial/);
    await expect(buildAbTrial(keep, '20261007T100000-aaaaaa', '1')).rejects.toThrow(/^trial not found/);
  });
});

describe('deleteAbTrial', () => {
  it('removes a lone label run from the keep and its row from the table', async () => {
    const session = '20261007T100000-aaaaaa';
    await writeLabel(session, { command: 'pr', recordedAt: '2026-10-07T10:00:00.000Z', verdict: 'b' });
    await ingest();

    const answer = await deleteAbTrial(logDir, keep, session, 1);
    expect(answer.deleted).toMatchObject({ session, id: 1, command: 'pr', removedRun: true });
    expect(await exists(path.join(keep, session))).toBe(false);
    expect(buildAbTrials(logDir).trials).toEqual([]);

    // Nothing left on disk for a later ingest to bring back.
    await ingest();
    expect(buildAbTrials(logDir).trials).toEqual([]);
  });

  it('keeps a run that holds other records, removing only the label', async () => {
    const session = '20261007T100000-aaaaaa';
    await writeLabel(session, { command: 'pr', recordedAt: '2026-10-07T10:00:00.000Z', verdict: 'b' });
    await writeFile(path.join(keep, session, '000002.json'), JSON.stringify({ v: 1, id: 2, request: {} }), 'utf8');
    await ingest();

    expect((await deleteAbTrial(logDir, keep, session, 1)).deleted.removedRun).toBe(false);
    expect(await exists(path.join(keep, session, '000001.json'))).toBe(false);
    expect(await exists(path.join(keep, session, '000002.json'))).toBe(true);
  });

  it('404s a trial that is not there', async () => {
    await expect(deleteAbTrial(logDir, keep, '20261007T100000-aaaaaa', 1)).rejects.toThrow(/^trial not found/);
  });
});
