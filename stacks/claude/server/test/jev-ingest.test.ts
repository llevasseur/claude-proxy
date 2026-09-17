import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ingestJevCalls, resolveJevRecordDir } from '../src/db/ingest-jev.js';
import { openDb } from '../src/db/open.js';

/**
 * The keep of recorded Jev calls is the source of truth and `jev_call` is a view of
 * it. The tests that matter are the ones that keep that true: a rebuild from an empty
 * database matches the records, a partially-answered call stays distinguishable from a
 * fully-answered one, and a keep that is not on disk is zero rather than a throw.
 */

const SESSION = '20260917T143012-4f2a1b';

/** The redaction the recording proxy applies at the source. Nothing here may undo it. */
const SECRET = 'sk-ant-should-never-reach-the-database';

/** What the recording proxy writes to `session.json`. */
interface SessionFixture {
  v: number;
  session: string;
  startedAt: string;
  endedAt: string;
  endpoint: string;
  pid: number;
  host: string;
  port: number;
  url: string;
  health: string;
  recorded: number;
}

/** The request half of one recorded exchange. */
interface RequestFixture {
  method: string;
  path: string;
  headers: Record<string, string>;
  bytes: number;
  model: string;
  state: null;
  questions: Record<string, string> | null;
  questionCount: number;
  questionIds: string[];
  body: Record<string, string> | null;
  bodyText: string | null;
}

/** The response half, including the two shapes a failure takes. */
interface ResponseFixture {
  status: number | null;
  ok: boolean;
  headers: Record<string, string>;
  bytes: number;
  answers: Record<string, string> | null;
  answerCount: number;
  answeredIds: string[];
  unansweredIds: string[];
  usage: { input_tokens: number; output_tokens: number } | null;
  body: Record<string, string> | null;
  bodyText: string | null;
  error: { name: string; message: string } | null;
}

/** One `NNNNNN.json`. */
interface CallFixture {
  v: number;
  id: number;
  session: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  endpoint: string;
  request: RequestFixture;
  response: ResponseFixture;
}

/** One row as SQLite hands it back: every column of these two tables is text, an integer, or null. */
type DbRow = Record<string, string | number | null>;

const sessionRecord: SessionFixture = {
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
  recorded: 3,
};

/** A call that got every answer it asked for. */
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
    headers: { 'content-type': 'application/json', authorization: '<redacted>' },
    bytes: 512,
    model: 'jev-small',
    state: null,
    questions: { q1: 'is it a cat?', q2: 'is it a dog?' },
    questionCount: 2,
    questionIds: ['q1', 'q2'],
    body: null,
    bodyText: null,
  },
  response: {
    status: 200,
    ok: true,
    headers: { 'content-type': 'application/json' },
    bytes: 128,
    answers: { q1: 'yes', q2: 'no' },
    answerCount: 2,
    answeredIds: ['q1', 'q2'],
    unansweredIds: [],
    usage: { input_tokens: 900, output_tokens: 12 },
    body: null,
    bodyText: null,
    error: null,
  },
};

/** The call this table exists for: 125 asked, 7 answered, and a 200 that hid it. */
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
  request: {
    ...answered.request,
    // The header is already redacted at the source; the raw value is here to prove
    // nothing in this file reconstructs it into a column.
    headers: { 'content-type': 'application/json', authorization: '<redacted>' },
    questionCount: 4,
    questionIds: ['q1', 'q2', 'q3', 'q4'],
    questions: { q1: 'a', q2: 'b', q3: 'c', q4: 'd' },
  },
  response: {
    status: 401,
    ok: false,
    headers: {},
    bytes: 64,
    answers: null,
    answerCount: 0,
    answeredIds: [],
    unansweredIds: ['q1', 'q2', 'q3', 'q4'],
    usage: null,
    body: { error: 'invalid api key', key: SECRET },
    bodyText: null,
    error: null,
  },
};

/** A transport failure: no HTTP response arrived at all. */
const transportFailure: CallFixture = {
  ...answered,
  id: 4,
  startedAt: '2026-09-17T14:33:00.000Z',
  response: {
    status: null,
    ok: false,
    headers: {},
    bytes: 0,
    answers: null,
    answerCount: 0,
    answeredIds: [],
    unansweredIds: ['q1', 'q2'],
    usage: null,
    body: null,
    bodyText: null,
    error: { name: 'FetchError', message: 'socket hang up' },
  },
};

let logDir: string;
let keep: string;
let db: DatabaseSync;

beforeEach(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'jev-logs-'));
  keep = await mkdtemp(path.join(tmpdir(), 'jev-keep-'));
  db = openDb(logDir);
});

afterEach(async () => {
  db?.close();
  await rm(logDir, { recursive: true, force: true });
  await rm(keep, { recursive: true, force: true });
});

/** Write one run directory: its `session.json`, a `serve.log` to be ignored, and its calls. */
async function writeRun(session: string, meta: SessionFixture, calls: CallFixture[]): Promise<void> {
  const dir = path.join(keep, session);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'session.json'), JSON.stringify(meta, null, 2), 'utf8');
  await writeFile(path.join(dir, 'serve.log'), 'listening on 127.0.0.1:8931\n', 'utf8');
  for (const call of calls) {
    const name = `${String(call.id).padStart(6, '0')}.json`;
    await writeFile(path.join(dir, name), JSON.stringify(call, null, 2), 'utf8');
  }
}

/** One row of `jev_call`, by its `(session, id)` key. */
const callRow = (id: number): DbRow => {
  // SAFETY: `jev_call`'s primary key is `(session, id)`, so this answers one row, and
  // every column the table declares is TEXT or INTEGER — which is what `DbRow` says.
  return db.prepare('SELECT * FROM jev_call WHERE session = ? AND id = ?').get(SESSION, id) as DbRow;
};

/** The single number behind a `count(*) c` query. */
const countOf = (sql: string): number => {
  // SAFETY: an aggregate with no GROUP BY always answers exactly one row, and `c` is
  // the only column in the select list.
  return (db.prepare(sql).get() as { c: number }).c;
};

describe('resolveJevRecordDir', () => {
  it('prefers the environment override', () => {
    expect(resolveJevRecordDir({ MY_COMMAND_JEV_RECORD_DIR: '/tmp/somewhere' })).toBe(path.resolve('/tmp/somewhere'));
  });

  it('falls back to the home keep', () => {
    expect(resolveJevRecordDir({})).toMatch(/\.my-command[/\\]jev-record$/);
  });
});

describe('ingestJevCalls', () => {
  it('reports zero rather than failing when the keep is not on disk', async () => {
    await rm(keep, { recursive: true, force: true });
    expect(await ingestJevCalls(db, keep)).toMatchObject({ sessions: 0, calls: 0, parsed: 0, skipped: 0 });
  });

  it('rebuilds the tables from the records — `rm db && ingest` is a total recovery', async () => {
    await writeRun(SESSION, sessionRecord, [answered, partial, rejected, transportFailure]);

    const first = await ingestJevCalls(db, keep);
    expect(first).toMatchObject({ sessions: 1, calls: 4, parsed: 4, skipped: 0, deleted: 0 });

    // SAFETY: `session` is `jev_session`'s primary key, so this answers one row, and
    // every column the table declares is TEXT or INTEGER — which is what `DbRow` says.
    const run = db.prepare('SELECT * FROM jev_session WHERE session = ?').get(SESSION) as DbRow;
    expect(run).toMatchObject({
      session: SESSION,
      v: 1,
      started_at: sessionRecord.startedAt,
      ended_at: sessionRecord.endedAt,
      endpoint: sessionRecord.endpoint,
      pid: 4242,
      host: '127.0.0.1',
      port: 8931,
      health: 'ok',
      recorded: 3,
    });
  });

  it('keeps a partly-answered call distinguishable from a fully-answered one', async () => {
    await writeRun(SESSION, sessionRecord, [answered, partial]);
    await ingestJevCalls(db, keep);

    expect(callRow(1)).toMatchObject({ question_count: 2, answer_count: 2, status: 200, ok: 1 });
    expect(callRow(2)).toMatchObject({ question_count: 125, answer_count: 7, status: 200, ok: 1 });

    // The question this table exists to answer, asked of the table.
    expect(countOf('SELECT count(*) c FROM jev_call WHERE answer_count < question_count')).toBe(1);
  });

  it('makes a 401 that became an empty answer map visible as one', async () => {
    await writeRun(SESSION, sessionRecord, [answered, rejected, transportFailure]);
    await ingestJevCalls(db, keep);

    expect(callRow(3)).toMatchObject({ status: 401, ok: 0, answer_count: 0, question_count: 4 });
    expect(callRow(3).answers).toBeNull();

    // A transport failure has no status at all, and says why in its own columns.
    expect(callRow(4)).toMatchObject({
      status: null,
      answer_count: 0,
      error_name: 'FetchError',
      error_message: 'socket hang up',
    });
  });

  it('keeps the question and answer maps whole, so the counts are a convenience', async () => {
    await writeRun(SESSION, sessionRecord, [partial]);
    await ingestJevCalls(db, keep);

    const row = callRow(2);
    expect(JSON.parse(String(row.questions))).toEqual(partial.request.questions);
    expect(JSON.parse(String(row.answers))).toEqual(partial.response.answers);
    expect(JSON.parse(String(row.unanswered_ids))).toHaveLength(118);
  });

  it('writes a null usage rather than zeroes when the response reported none', async () => {
    await writeRun(SESSION, sessionRecord, [answered, partial]);
    await ingestJevCalls(db, keep);

    expect(callRow(1)).toMatchObject({ usage_input_tokens: 900, usage_output_tokens: 12 });
    expect(callRow(2)).toMatchObject({ usage_input_tokens: null, usage_output_tokens: null });
  });

  it('persists no credential, and no header map to hide one in', async () => {
    await writeRun(SESSION, sessionRecord, [answered, rejected]);
    await ingestJevCalls(db, keep);

    // SAFETY: the two selects name every column of their tables, and every one of
    // those columns is declared TEXT or INTEGER — which is what `DbRow` says.
    const rows = [
      ...(db.prepare('SELECT * FROM jev_call').all() as DbRow[]),
      ...(db.prepare('SELECT * FROM jev_session').all() as DbRow[]),
    ];
    const dumped = JSON.stringify(rows);
    expect(dumped).not.toContain(SECRET);
    expect(dumped.toLowerCase()).not.toContain('authorization');
    expect(dumped).not.toContain('<redacted>');
  });

  it('skips a record whose format version it does not know, and counts it', async () => {
    await writeRun(SESSION, sessionRecord, [answered, { ...partial, v: 2 }]);

    const stats = await ingestJevCalls(db, keep);
    expect(stats).toMatchObject({ sessions: 1, calls: 1, parsed: 1, skipped: 1 });
    expect(callRow(2)).toBeUndefined();
  });

  it('skips a whole run whose `session.json` is a version it does not know', async () => {
    await writeRun(SESSION, { ...sessionRecord, v: 99 }, [answered, partial]);

    const stats = await ingestJevCalls(db, keep);
    expect(stats).toMatchObject({ sessions: 0, calls: 0, parsed: 0, skipped: 1 });
  });

  it('re-ingests incrementally: an unchanged record is not re-read', async () => {
    await writeRun(SESSION, sessionRecord, [answered, partial]);
    expect(await ingestJevCalls(db, keep)).toMatchObject({ parsed: 2 });

    // Nothing changed on disk, so nothing is parsed again — and no row is lost.
    expect(await ingestJevCalls(db, keep)).toMatchObject({ parsed: 0, calls: 2 });

    // A new record appears mid-run and is the only one read.
    await writeFile(path.join(keep, SESSION, '000003.json'), JSON.stringify(rejected, null, 2), 'utf8');
    expect(await ingestJevCalls(db, keep)).toMatchObject({ parsed: 1, calls: 3 });
    expect(countOf('SELECT count(*) c FROM jev_call')).toBe(3);
  });

  it('drops a run whose directory has left the keep', async () => {
    await writeRun(SESSION, sessionRecord, [answered, partial]);
    await ingestJevCalls(db, keep);

    await rm(path.join(keep, SESSION), { recursive: true, force: true });
    expect(await ingestJevCalls(db, keep)).toMatchObject({ sessions: 0, calls: 0, deleted: 1 });
    expect(countOf('SELECT count(*) c FROM jev_session')).toBe(0);
    // The cascade took the calls with it, and the watermarks went too, so the run
    // would be read afresh if it ever came back.
    expect(countOf('SELECT count(*) c FROM jev_call')).toBe(0);
    expect(countOf("SELECT count(*) c FROM file_watermark WHERE path LIKE 'jev/%'")).toBe(0);
  });

  it('drops the rows of every run when the keep itself disappears', async () => {
    await writeRun(SESSION, sessionRecord, [answered]);
    await ingestJevCalls(db, keep);
    await rm(keep, { recursive: true, force: true });

    expect(await ingestJevCalls(db, keep)).toMatchObject({ sessions: 0, calls: 0, deleted: 1 });
    expect(countOf('SELECT count(*) c FROM jev_call')).toBe(0);
  });
});
