import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBackup } from '../src/backup.ts';
import type { Db } from '../src/db.ts';
import worker from '../src/index.ts';
import type { JsonValue } from '../src/json.ts';
import {
  archiveNote,
  createNote,
  exportNotes,
  getNote,
  listNotes,
  noteExcerpt,
  restoreNote,
  searchNotes,
  updateNote,
} from '../src/notes.ts';
import { handleRest } from '../src/rest.ts';
import { bodyRecord, recordAt, recordsAt, testDb, testEnv, textAt, textRecord } from './harness.ts';

const T0 = new Date('2026-08-16T10:00:00.000Z');
const T1 = new Date('2026-08-16T11:00:00.000Z');

function request(path: string, method = 'GET', body?: JsonValue) {
  const url = new URL(`https://operator.example${path}`);
  return {
    url,
    request: new Request(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  };
}

async function rest(db: Db, path: string, method = 'GET', body?: JsonValue) {
  const input = request(path, method, body);
  return (await handleRest(input.request, input.url, db))!;
}

describe('notes domain', () => {
  it('stores a blank title and Markdown without transformation', async () => {
    const db = testDb();
    const body = '# Heading\n\n- one\n- two\n';
    const note = await createNote(db, { title: '', body }, T0);
    expect(note).toMatchObject({
      title: '',
      body,
      version: 1,
      createdAt: T0.toISOString(),
      updatedAt: T0.toISOString(),
    });
    expect(await getNote(db, note.id)).toEqual(note);
  });

  it('derives an approximately 200-character plain-text excerpt', () => {
    const excerpt = noteExcerpt(`# Title\n\n${'**word** '.repeat(40)}<em>HTML</em> [link](https://example.com)`);
    expect(excerpt.startsWith('Title word word')).toBe(true);
    expect(excerpt).not.toMatch(/[*#[\]()<]/);
    expect(excerpt.length).toBeLessThanOrEqual(200);
  });

  it('orders active notes by updatedAt then id and paginates with an opaque cursor', async () => {
    const db = testDb();
    const older = await createNote(db, { title: 'older', body: 'a' }, T0);
    const newer = await createNote(db, { title: 'newer', body: 'b' }, T1);
    const first = await listNotes(db, { limit: 1 });
    expect(first.notes.map((note) => note.id)).toEqual([newer.id]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await listNotes(db, { limit: 1, cursor: first.nextCursor! });
    expect(second.notes.map((note) => note.id)).toEqual([older.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('searches the current title and Markdown body but returns only an excerpt', async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'Release', body: 'The aardvark rollout plan.' }, T0);
    const page = await searchNotes(db, 'aardvark');
    expect(page.notes).toHaveLength(1);
    expect(page.notes[0]).toMatchObject({ id: note.id, excerpt: 'The aardvark rollout plan.' });
    expect(page.notes[0]).not.toHaveProperty('body');
  });

  it('treats search input as text instead of exposing FTS operators and syntax errors', async () => {
    const db = testDb();
    await createNote(db, { title: 'C++ move semantics', body: 'Handle an "unbalanced quote.' }, T0);
    await expect(searchNotes(db, 'C++ (move)')).resolves.toMatchObject({ notes: [{ title: 'C++ move semantics' }] });
    await expect(searchNotes(db, '"unbalanced')).resolves.toMatchObject({ notes: [{ title: 'C++ move semantics' }] });
  });

  it('does not advance updatedAt or version for no-op updates, archive, or restore', async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'same', body: 'same' }, T0);
    const noOp = await updateNote(db, note.id, { expectedVersion: 1, title: 'same', body: 'same' }, T1);
    expect(noOp).toMatchObject({ changed: false, note: { version: 1, updatedAt: T0.toISOString() } });
    expect(await archiveNote(db, note.id, T1)).toMatchObject({ version: 1, updatedAt: T0.toISOString() });
    const archivedExport = textRecord(await exportNotes(db));
    expect(recordsAt(archivedExport, 'notes')[0]?.archived_at).toBe(T1.toISOString());
    expect((await listNotes(db)).notes).toEqual([]);
    expect(await restoreNote(db, note.id)).toMatchObject({ version: 1, updatedAt: T0.toISOString(), archivedAt: null });
  });

  it('lets one same-version writer commit, returns one conflict, and retains both attempted bodies', async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'Race', body: 'base' }, T0);
    const results = await Promise.all([
      updateNote(db, note.id, { expectedVersion: 1, body: 'writer A' }, T1),
      updateNote(db, note.id, { expectedVersion: 1, body: 'writer B' }, T1),
    ]);
    expect(results.filter((result) => 'conflict' in result)).toHaveLength(1);
    expect(results.filter((result) => !('conflict' in result))).toHaveLength(1);
    expect((await getNote(db, note.id))?.version).toBe(2);

    const revisions = recordsAt(textRecord(await exportNotes(db)), 'revisions');
    expect(revisions.map((revision) => textAt(revision, 'body')).sort()).toEqual(['base', 'writer A', 'writer B']);
    expect(revisions.map((revision) => textAt(revision, 'outcome')).sort()).toEqual([
      'committed',
      'committed',
      'conflict',
    ]);
  });

  it("retains a stale partial update against the writer's expected revision", async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'original title', body: 'base' }, T0);
    await updateNote(db, note.id, { expectedVersion: 1, title: 'winner title' }, T1);
    await updateNote(db, note.id, { expectedVersion: 1, body: 'loser body' }, T1);

    const revisions = recordsAt(textRecord(await exportNotes(db)), 'revisions');
    expect(revisions.find((revision) => textAt(revision, 'outcome') === 'conflict')).toMatchObject({
      title: 'original title',
      body: 'loser body',
    });
  });
});

describe('notes REST', () => {
  it('supports create, get, list, search, archive, and restore', async () => {
    const db = testDb();
    const created = await rest(db, '/api/notes', 'POST', { title: 'REST', body: 'searchable yak' });
    expect(created.status).toBe(201);
    const id = textAt(recordAt(await bodyRecord(created), 'note'), 'id');
    expect((await rest(db, `/api/notes/note?id=${id}`)).status).toBe(200);
    expect((await rest(db, '/api/notes')).status).toBe(200);
    expect((await rest(db, '/api/notes/search?q=yak')).status).toBe(200);
    expect((await rest(db, '/api/notes/archive', 'POST', { id })).status).toBe(200);
    expect((await rest(db, '/api/notes/restore', 'POST', { id })).status).toBe(200);
  });

  it('returns HTTP 409 with the retained revision id for a stale update', async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'REST', body: 'base' }, T0);
    expect(
      (await rest(db, '/api/notes/update', 'POST', { id: note.id, expectedVersion: 1, body: 'winner' })).status,
    ).toBe(200);
    const response = await rest(db, '/api/notes/update', 'POST', {
      id: note.id,
      expectedVersion: 1,
      body: 'loser',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      conflict: true,
      code: 'stale_version',
      expectedVersion: 1,
      currentVersion: 2,
      attemptedRevisionId: expect.any(String),
    });
  });
});

describe('notes Worker auth', () => {
  it('rejects every notes REST operation and MCP before opening the database', async () => {
    const paths = [
      ['/api/notes', 'GET'],
      ['/api/notes', 'POST'],
      ['/api/notes/search?q=test', 'GET'],
      ['/api/notes/note?id=test', 'GET'],
      ['/api/notes/update', 'POST'],
      ['/api/notes/archive', 'POST'],
      ['/api/notes/restore', 'POST'],
      ['/mcp', 'POST'],
    ] as const;
    for (const [path, method] of paths) {
      const response = await worker.fetch(new Request(`https://operator.example${path}`, { method }), testEnv());
      expect(response.status, `${method} ${path}`).toBe(401);
    }
  });
});

describe('notes backup', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes every revision and archive state to the configured nightly backup path', async () => {
    const db = testDb();
    const note = await createNote(db, { title: 'Backup', body: 'version one' }, T0);
    await updateNote(db, note.id, { expectedVersion: 1, body: 'version two' }, T1);
    await archiveNote(db, note.id, T1);

    const writes = new Map<string, string>();
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
      if (init?.method !== 'PUT') return new Response('', { status: 404 });
      const body = textRecord(String(init.body));
      writes.set(new URL(url).pathname, Buffer.from(textAt(body, 'content'), 'base64').toString('utf8'));
      return new Response('{}', { status: 200 });
    });

    const result = await runBackup(
      db,
      testEnv({
        BACKUP_GITHUB_TOKEN: 'backup-token',
        BACKUP_REPO: 'owner/private-backup',
        BACKUP_NOTES_PATH: 'operator-notes.json',
      }),
    );

    expect(result.notes.status).toBe('committed');
    const committed = writes.get('/repos/owner/private-backup/contents/operator-notes.json');
    expect(committed).toEqual(expect.any(String));
    const backup = textRecord(String(committed));
    expect(recordsAt(backup, 'notes')).toEqual([expect.objectContaining({ archived_at: T1.toISOString() })]);
    const revisions = recordsAt(backup, 'revisions');
    expect(revisions.map((revision) => textAt(revision, 'body'))).toEqual(['version one', 'version two']);
    expect(revisions.every((revision) => textAt(revision, 'outcome') === 'committed')).toBe(true);
  });
});
