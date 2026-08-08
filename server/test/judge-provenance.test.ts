// A verdict's provenance is half claim and half arithmetic: the judging thread id is
// what the caller passes, but how much of the window that thread opened is read back
// off its own transcript. These check the arithmetic against a real log directory.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySuggestionJudge } from '../src/api.js';
import { readSuggestionStatusStore } from '../src/suggestion-status.js';

/** Ten window transcripts plus the judge's, oldest first so the judge falls outside bucket 1. */
const WINDOW = Array.from({ length: 10 }, (_, i) => `aaaaaaaaaaaaaa${String(i).padStart(2, '0')}`);
const JUDGE = 'ffffffffffffffff';

function transcript(threadId: string, started: string, toolLines: readonly string[]): string {
  return [
    `# Session ${threadId}`,
    '- model: claude-opus-5',
    `- session: sess-${threadId}`,
    `- started: ${started}`,
    '',
    '## Task: do a thing',
    ...toolLines.map((line) => `- ${line}`),
    '',
  ].join('\n');
}

/** A log dir whose judge transcript opened `opened` of the ten window transcripts. */
async function corpus(opened: number, judgeLines?: readonly string[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'judge-provenance-'));
  await mkdir(path.join(dir, 'sessions'), { recursive: true });
  await Promise.all(
    WINDOW.map((id, i) =>
      writeFile(
        path.join(dir, 'sessions', `${id}.md`),
        transcript(id, `2026-08-0${1 + Math.floor(i / 5)}T0${i % 5}:00:00.000Z`, ['Bash(command=ls)']),
      ),
    ),
  );
  const lines = judgeLines ?? WINDOW.slice(0, opened).map((id) => `Read(file_path=logs/sessions/${id}.md)`);
  await writeFile(path.join(dir, 'sessions', `${JUDGE}.md`), transcript(JUDGE, '2026-08-09T00:00:00.000Z', lines));
  return dir;
}

describe('applySuggestionJudge records who judged and how much they read', () => {
  it('derives the opened count off the judging thread rather than trusting it', async () => {
    const dir = await corpus(4);
    await applySuggestionJudge(dir, { judged: [{ bucket: 1, notes: {} }], thread: JUDGE });

    const store = await readSuggestionStatusStore(dir);
    expect(store.judged['1']?.by).toEqual({ thread: JUDGE, window: 10, opened: 4 });
  });

  it('marks a bucket thin when the judge opened almost none of it', async () => {
    const dir = await corpus(1);
    const result = await applySuggestionJudge(dir, { judged: [{ bucket: 1, notes: {} }], thread: JUDGE });

    expect(result.buckets[0]?.by).toEqual({ thread: JUDGE, window: 10, opened: 1 });
    expect(result.buckets[0]?.thin).toBe(true);
    // Advisory only: the verdict itself still landed clean.
    expect(result.buckets[0]?.state).toBe('clean');
  });

  it('leaves a verdict unattributed when no thread is passed, exactly as before', async () => {
    const dir = await corpus(4);
    const result = await applySuggestionJudge(dir, { judged: [{ bucket: 1, notes: {} }] });

    expect(result.buckets[0]?.by).toBeUndefined();
    expect(result.buckets[0]?.thin).toBeUndefined();
    expect((await readSuggestionStatusStore(dir)).judged['1']?.by).toBeUndefined();
  });

  it('records the claim alone when the named thread has no transcript on disk', async () => {
    const dir = await corpus(4);
    const result = await applySuggestionJudge(dir, {
      judged: [{ bucket: 1, notes: {} }],
      thread: 'deadbeefdeadbeef',
    });

    // Unknown, not zero — so it is never marked thin.
    expect(result.buckets[0]?.by).toEqual({ thread: 'deadbeefdeadbeef' });
    expect(result.buckets[0]?.thin).toBeUndefined();
  });

  it('ignores a malformed thread id rather than refusing the verdict', async () => {
    const dir = await corpus(4);
    const result = await applySuggestionJudge(dir, { judged: [{ bucket: 1, notes: {} }], thread: 'nope' });

    expect(result.buckets[0]?.by).toBeUndefined();
    expect(result.buckets[0]?.state).toBe('clean');
  });

  it('counts a transcript a Bash call grepped, not only one a Read opened', async () => {
    const dir = await corpus(0, [
      `Bash(command=rg -n Error logs/sessions/${WINDOW[0]}.md logs/sessions/${WINDOW[1]}.md)`,
    ]);
    await applySuggestionJudge(dir, { judged: [{ bucket: 1, notes: {} }], thread: JUDGE });

    expect((await readSuggestionStatusStore(dir)).judged['1']?.by?.opened).toBe(2);
  });
});
