import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildJevCalls, isJevCallFilter, type JevCallRow } from '../src/api.js';
import { ingestJevCalls } from '../src/db/ingest-jev.js';
import { openDb } from '../src/db/open.js';

/**
 * The read half of the recorded Jev traffic.
 *
 * `jev-ingest.test.ts` covers the rows arriving; this covers what a person is shown
 * once they have. The claims that matter are the ones the page is for: a call that
 * asked 125 questions and got 7 is legible as short without opening a JSON column, a
 * 401 and a transport error are both `failed` while staying distinguishable, a
 * response that reported no usage stays null rather than becoming zero, and a machine
 * that has recorded nothing answers with an empty payload instead of throwing.
 */

const SESSION = '20260917T143012-4f2a1b';

/** The keep's own record shapes, only as far as this file writes them. */
interface CallFixture {
  v: number;
  id: number;
  session: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  endpoint: string;
  request: {
    method: string;
    path: string;
    bytes: number;
    model: string;
    questions: Record<string, string> | null;
    questionCount: number;
    questionIds: string[];
  };
  response: {
    status: number | null;
    ok: boolean;
    bytes: number;
    answers: Record<string, string> | null;
    answerCount: number;
    answeredIds: string[];
    unansweredIds: string[];
    usage: { input_tokens: number; output_tokens: number } | null;
    error: { name: string; message: string } | null;
  };
}

const sessionRecord = {
  v: 1,
  session: SESSION,
  startedAt: '2026-09-17T14:30:12.000Z',
  endedAt: '2026-09-17T14:41:00.000Z',
  endpoint: 'https://system-one.example/v1/classify',
  pid: 4242,
  host: '127.0.0.1',
  port: 8931,
  url: 'http://127.0.0.1:8931',
  health: 'ok',
  recorded: 4,
};

/** A call that got every answer it asked for, and reported what it cost. */
const answered: CallFixture = {
  v: 1,
  id: 1,
  session: SESSION,
  startedAt: '2026-09-17T14:30:20.000Z',
  endedAt: '2026-09-17T14:30:21.500Z',
  durationMs: 1500,
  endpoint: 'https://system-one.example/v1/classify',
  request: {
    method: 'POST',
    path: '/v1/classify',
    bytes: 512,
    model: 'jev-small',
    questions: { q1: 'is it a cat?', q2: 'is it a dog?' },
    questionCount: 2,
    questionIds: ['q1', 'q2'],
  },
  response: {
    status: 200,
    ok: true,
    bytes: 128,
    answers: { q1: 'yes', q2: 'no' },
    answerCount: 2,
    answeredIds: ['q1', 'q2'],
    unansweredIds: [],
    usage: { input_tokens: 900, output_tokens: 12 },
    error: null,
  },
};

/** The call this page exists for: 125 asked, 7 answered, behind a 200 that hid it. */
const partial: CallFixture = {
  ...answered,
  id: 2,
  startedAt: '2026-09-17T14:31:00.000Z',
  request: {
    ...answered.request,
    questionCount: 125,
    questionIds: Array.from({ length: 125 }, (_, i) => `q${i + 1}`),
    questions: Object.fromEntries(Array.from({ length: 125 }, (_, i) => [`q${i + 1}`, `question ${i + 1}`])),
  },
  response: {
    ...answered.response,
    answerCount: 7,
    answers: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`q${i + 1}`, 'yes'])),
    answeredIds: Array.from({ length: 7 }, (_, i) => `q${i + 1}`),
    unansweredIds: Array.from({ length: 118 }, (_, i) => `q${i + 8}`),
    // The response reported no usage. An unknown cost is never written as zeroes.
    usage: null,
  },
};

/** A 401 the client turned into an empty answer map. */
const rejected: CallFixture = {
  ...answered,
  id: 3,
  startedAt: '2026-09-17T14:32:00.000Z',
  request: { ...answered.request, questionCount: 4, questionIds: ['q1', 'q2', 'q3', 'q4'] },
  response: {
    ...answered.response,
    status: 401,
    ok: false,
    answers: null,
    answerCount: 0,
    answeredIds: [],
    unansweredIds: ['q1', 'q2', 'q3', 'q4'],
    usage: null,
  },
};

/** A transport failure: no HTTP response arrived at all, so there is no status to show. */
const transportFailure: CallFixture = {
  ...answered,
  id: 4,
  startedAt: '2026-09-17T14:33:00.000Z',
  response: {
    ...answered.response,
    status: null,
    ok: false,
    bytes: 0,
    answers: null,
    answerCount: 0,
    answeredIds: [],
    unansweredIds: ['q1', 'q2'],
    usage: null,
    error: { name: 'FetchError', message: 'socket hang up' },
  },
};

let logDir: string;
let keep: string;
let db: DatabaseSync;
/**
 * Whether the writer is still open. Every read below opens its own read-only handle,
 * so a test closes the writer first; the teardown must not close it a second time,
 * which `node:sqlite` answers with `database is not open`.
 */
let writerOpen = false;

/** Close the writing handle, once. */
function closeWriter(): void {
  if (!writerOpen) return;
  writerOpen = false;
  db.close();
}

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'jev-read-logs-'));
  keep = await mkdtemp(path.join(tmpdir(), 'jev-read-keep-'));
  db = openDb(logDir);
  writerOpen = true;
});

afterEach(async () => {
  closeWriter();
  await rm(logDir, { recursive: true, force: true });
  await rm(keep, { recursive: true, force: true });
});

async function writeRun(calls: CallFixture[]): Promise<void> {
  const dir = path.join(keep, SESSION);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(sessionRecord, null, 2), 'utf8');
  for (const call of calls) {
    await writeFile(path.join(dir, `${String(call.id).padStart(6, '0')}.json`), JSON.stringify(call, null, 2), 'utf8');
  }
}

/** Ingest the four fixtures, then close the writer so the read opens its own handle. */
async function recorded(): Promise<void> {
  await writeRun([answered, partial, rejected, transportFailure]);
  await ingestJevCalls(db, keep);
  closeWriter();
}

const byId = (calls: JevCallRow[], id: number): JevCallRow => {
  const found = calls.find((call) => call.id === id);
  if (!found) throw new Error(`no call ${id} in the answer`);
  return found;
};

describe('isJevCallFilter', () => {
  it('admits the three filters and nothing else', () => {
    expect(isJevCallFilter('all')).toBe(true);
    expect(isJevCallFilter('unanswered')).toBe(true);
    expect(isJevCallFilter('failed')).toBe(true);
    // The one that matters: an unrecognised filter must not pass as "everything".
    expect(isJevCallFilter('everything')).toBe(false);
    expect(isJevCallFilter('')).toBe(false);
  });
});

describe('buildJevCalls', () => {
  it('answers empty rather than throwing when nothing has been recorded', () => {
    closeWriter();
    // A directory with no database file at all — a machine that never ran the proxy.
    const answer = buildJevCalls(path.join(logDir, 'nowhere'));
    expect(answer.calls).toEqual([]);
    expect(answer.sessions).toEqual([]);
    expect(answer.meta.substrate).toBe(false);
    expect(answer.meta.counts.total).toBe(0);
  });

  it('answers empty for a migrated database that holds no calls', () => {
    closeWriter();
    const answer = buildJevCalls(logDir);
    expect(answer.calls).toEqual([]);
    // The substrate is there; it simply has nothing in it. That distinction is what
    // lets the page tell "never recorded" from "recorded, then pruned".
    expect(answer.meta.substrate).toBe(true);
    expect(answer.meta.counts.total).toBe(0);
  });

  it('makes a partially-answered call legible without reading a JSON column', async () => {
    await recorded();
    const call = byId(buildJevCalls(logDir).calls, 2);
    expect(call.questionCount).toBe(125);
    expect(call.answerCount).toBe(7);
    expect(call.unansweredCount).toBe(118);
    expect(call.outcome).toBe('partial');
    // A 200 is what hid it: the status alone says nothing is wrong.
    expect(call.status).toBe(200);
    expect(call.ok).toBe(true);
  });

  it('never reports an unreported usage count as zero', async () => {
    await recorded();
    const calls = buildJevCalls(logDir).calls;
    expect(byId(calls, 1).usageInputTokens).toBe(900);
    expect(byId(calls, 1).usageOutputTokens).toBe(12);
    // The response reported none. Null is "unknown", and zero would claim it was free.
    expect(byId(calls, 2).usageInputTokens).toBeNull();
    expect(byId(calls, 2).usageOutputTokens).toBeNull();
  });

  it('calls both failure shapes failed, and keeps them apart', async () => {
    await recorded();
    const calls = buildJevCalls(logDir).calls;

    const status = byId(calls, 3);
    expect(status.outcome).toBe('failed');
    expect(status.status).toBe(401);
    expect(status.errorName).toBeNull();

    const transport = byId(calls, 4);
    expect(transport.outcome).toBe('failed');
    // No response arrived, so there is no status to show — the error is what there is.
    expect(transport.status).toBeNull();
    expect(transport.errorName).toBe('FetchError');
    expect(transport.errorMessage).toBe('socket hang up');
  });

  it('counts the whole table regardless of the filter in force', async () => {
    await recorded();
    const failedOnly = buildJevCalls(logDir, { filter: 'failed' });
    expect(failedOnly.calls.map((call) => call.id).sort()).toEqual([3, 4]);
    expect(failedOnly.meta.matched).toBe(2);
    // The tally is over every row, so a narrowed page can still say what it is hiding.
    expect(failedOnly.meta.counts).toMatchObject({ total: 4, ok: 1, partial: 1, empty: 0, failed: 2 });
    expect(failedOnly.meta.counts.unansweredQuestions).toBe(118 + 4 + 2);
  });

  it('narrows to the short calls, which includes the ones that answered nothing', async () => {
    await recorded();
    const short = buildJevCalls(logDir, { filter: 'unanswered' });
    // Every call that got fewer answers than it asked questions — the partial one and
    // both failures, since a failure answers nothing at all.
    expect(short.calls.map((call) => call.id).sort()).toEqual([2, 3, 4]);
  });

  it('returns newest first and names only the runs its rows belong to', async () => {
    await recorded();
    const answer = buildJevCalls(logDir);
    expect(answer.calls.map((call) => call.id)).toEqual([4, 3, 2, 1]);
    expect(answer.sessions).toHaveLength(1);
    expect(answer.sessions[0]).toMatchObject({ session: SESSION, endpoint: sessionRecord.endpoint, recorded: 4 });
  });

  it('clamps the limit and reports how much it left out', async () => {
    await recorded();
    const answer = buildJevCalls(logDir, { limit: '2' });
    expect(answer.meta.limit).toBe(2);
    expect(answer.meta.returned).toBe(2);
    expect(answer.meta.matched).toBe(4);
    // An unreadable limit falls back rather than returning nothing.
    expect(buildJevCalls(logDir, { limit: 'lots' }).meta.returned).toBe(4);
    expect(buildJevCalls(logDir, { limit: '-3' }).meta.returned).toBe(4);
  });
});
