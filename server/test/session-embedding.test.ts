// The embedding route is driven over real transcript files, since what it has to get right is
// the read out of `logs/sessions/` and the command label off each transcript's own subtitle —
// neither of which a hand-built `ProjectableSession` would exercise.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSessionEmbedding, SESSION_EMBEDDING_LIMIT } from '../src/api.js';

/** The envelope shape the CLI sends, with the command definition inlined after the args. */
const DEFINITION =
  ' Take a task from a plain-language description all the way to an open PR. The git plumbing runs through my-command-tools.';

function envelope(command: string, args: string): string {
  return `<command-message>${command}</command-message> <command-name>/${command}</command-name> <command-args>${args}</command-args>${DEFINITION}`;
}

interface Spec {
  id: string;
  command: string | null;
  subject: string[];
  minutes: number;
}

/** Write one transcript in the shape `proxy/session.ts` writes. */
async function writeTranscript(dir: string, spec: Spec): Promise<void> {
  const criteria = spec.subject.join(' ');
  const started = new Date(Date.UTC(2026, 7, 1, 10, spec.minutes)).toISOString();
  const lines = [
    `# Session ${spec.id}`,
    '- model: claude-opus-4-8',
    `- session: sess-${spec.id.slice(0, 4)}`,
    `- started: ${started}`,
    `- subtitle: ${spec.command ? envelope(spec.command, criteria) : criteria}`,
    '',
    `## Task: ${criteria}`,
  ];
  for (const [i, word] of spec.subject.entries()) {
    lines.push(`- decided: ${word} ${spec.subject[(i + 1) % spec.subject.length]}`);
    lines.push(`- Edit(file_path=src/${word}.ts)`);
  }
  lines.push('- done: shipped');
  await writeFile(path.join(dir, `${spec.id}.md`), `${lines.join('\n')}\n`);
}

const SCROLL = ['scroll', 'panel', 'artifact', 'overflow', 'viewport'];
const CACHE = ['cache', 'token', 'prefix', 'breakpoint', 'ephemeral'];

const CORPUS: Spec[] = [
  { id: 'aaaaaaaaaaaaaaa1', command: 'task', subject: SCROLL, minutes: 1 },
  { id: 'aaaaaaaaaaaaaaa2', command: 'fb', subject: SCROLL, minutes: 2 },
  { id: 'aaaaaaaaaaaaaaa3', command: 'task', subject: SCROLL, minutes: 3 },
  { id: 'bbbbbbbbbbbbbbb1', command: 'god', subject: CACHE, minutes: 4 },
  { id: 'bbbbbbbbbbbbbbb2', command: 'task', subject: CACHE, minutes: 5 },
  { id: 'bbbbbbbbbbbbbbb3', command: null, subject: CACHE, minutes: 6 },
];

/** A log dir holding `CORPUS` as transcripts. */
async function seed(extra: Spec[] = []): Promise<string> {
  const logDir = await mkdtemp(path.join(tmpdir(), 'session-embedding-'));
  const dir = path.join(logDir, 'sessions');
  await mkdir(dir, { recursive: true });
  for (const spec of [...CORPUS, ...extra]) await writeTranscript(dir, spec);
  return logDir;
}

describe('buildSessionEmbedding', () => {
  it('projects every transcript and names where they came from', async () => {
    const logDir = await seed();
    const { points, meta } = await buildSessionEmbedding(logDir, { perplexity: 2 });
    expect(points).toHaveLength(6);
    expect(meta.total).toBe(6);
    expect(meta.sessions).toBe(6);
    expect(meta.skipped).toBe(0);
    expect(meta.sessionsDir).toBe(path.join(logDir, 'sessions'));
    expect(meta.vocabulary).toBeGreaterThan(0);
  });

  it("labels each dot with the slash command that ran it, read off the transcript's subtitle", async () => {
    const logDir = await seed();
    const { points, commands } = await buildSessionEmbedding(logDir, { perplexity: 2 });
    const commandOf = (id: string) => points.find((p) => p.threadId === id)?.command;
    expect(commandOf('aaaaaaaaaaaaaaa1')).toBe('task');
    expect(commandOf('aaaaaaaaaaaaaaa2')).toBe('fb');
    expect(commandOf('bbbbbbbbbbbbbbb1')).toBe('god');
    // No envelope in the subtitle — an ordinary session, not a run.
    expect(commandOf('bbbbbbbbbbbbbbb3')).toBeNull();
    expect(commands).toEqual([
      { command: 'task', sessions: 3 },
      { command: 'fb', sessions: 1 },
      { command: 'god', sessions: 1 },
      { command: null, sessions: 1 },
    ]);
  });

  it('places same-subject transcripts nearer each other than cross-subject ones', async () => {
    const logDir = await seed();
    const { points } = await buildSessionEmbedding(logDir, { perplexity: 2 });
    const at = (id: string) => points.find((p) => p.threadId === id)!;
    const gap = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    const within = Math.max(
      gap('aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2'),
      gap('aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa3'),
      gap('bbbbbbbbbbbbbbb1', 'bbbbbbbbbbbbbbb2'),
    );
    const across = Math.min(gap('aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb1'), gap('aaaaaaaaaaaaaaa3', 'bbbbbbbbbbbbbbb2'));
    expect(within).toBeLessThan(across);
  });

  it('groups by subject rather than by the command envelope every run of one command shares', async () => {
    // The three `/task` runs span both subjects. If the inlined command definition reached the
    // vector they would cluster together and the colouring would only ever prove itself.
    const logDir = await seed();
    const { points } = await buildSessionEmbedding(logDir, { perplexity: 2 });
    const at = (id: string) => points.find((p) => p.threadId === id)!;
    const gap = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    // Two `/task` runs on different subjects sit further apart than two different commands
    // on the same subject.
    expect(gap('aaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaa2')).toBeLessThan(gap('aaaaaaaaaaaaaaa1', 'bbbbbbbbbbbbbbb2'));
  });

  it('bounds the window to the newest transcripts, so the O(n²) layout cannot run away', async () => {
    const logDir = await seed();
    const { points, meta } = await buildSessionEmbedding(logDir, { perplexity: 2, limit: 2 });
    expect(points).toHaveLength(2);
    // `total` still reports the whole corpus, so a narrowed view says how much it hid.
    expect(meta.total).toBe(6);
    expect(meta.sessions).toBe(2);
    // Newest first by mtime, so the window is the most recently written pair.
    expect(points.map((p) => p.threadId).sort()).toHaveLength(2);
  });

  it('never exceeds the default ceiling however large a limit is asked for', async () => {
    const logDir = await seed();
    const { meta } = await buildSessionEmbedding(logDir, { perplexity: 2, limit: 10_000 });
    expect(meta.sessions).toBeLessThanOrEqual(SESSION_EMBEDDING_LIMIT);
    expect(meta.sessions).toBe(6);
  });

  it('reads as empty rather than throwing when no transcripts exist yet', async () => {
    const logDir = await mkdtemp(path.join(tmpdir(), 'session-embedding-empty-'));
    const { points, commands, meta } = await buildSessionEmbedding(logDir);
    expect(points).toEqual([]);
    expect(commands).toEqual([]);
    expect(meta.total).toBe(0);
    expect(meta.sessions).toBe(0);
  });

  it('skips a header-only transcript instead of placing it somewhere it does not belong', async () => {
    const logDir = await seed();
    // A transcript the proxy opened and never appended to: header, no task, no steps.
    await writeFile(
      path.join(logDir, 'sessions', 'cccccccccccccccc.md'),
      ['# Session cccccccccccccccc', '- model: claude-opus-4-8', '- session: sess-cccc', ''].join('\n'),
    );
    const { points, meta } = await buildSessionEmbedding(logDir, { perplexity: 2 });
    expect(meta.total).toBe(7);
    expect(meta.sessions).toBe(6);
    expect(meta.skipped).toBe(1);
    expect(points.some((p) => p.threadId === 'cccccccccccccccc')).toBe(false);
  });

  it('is reproducible: the same transcripts project to the same coordinates', async () => {
    const logDir = await seed();
    const a = await buildSessionEmbedding(logDir, { perplexity: 2 });
    const b = await buildSessionEmbedding(logDir, { perplexity: 2 });
    expect(a.points.map((p) => [p.threadId, p.x, p.y])).toEqual(b.points.map((p) => [p.threadId, p.x, p.y]));
  });

  it('clamps a perplexity the corpus is too small to support', async () => {
    const logDir = await seed();
    const { meta } = await buildSessionEmbedding(logDir, { perplexity: 500 });
    expect(meta.perplexity).toBeLessThan(500);
    expect(meta.sessions).toBe(6);
  });
});
