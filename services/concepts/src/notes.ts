import type { Db } from './db.ts';
import { isJsonInteger, isJsonRecord, isJsonText, type JsonRecord, type JsonValue, parseJson } from './json.ts';
import { toMatchQuery } from './store.ts';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export class NoteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Note {
  id: string;
  version: number;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface NoteSummary extends Omit<Note, 'body'> {
  excerpt: string;
}

export interface NotePage {
  notes: NoteSummary[];
  nextCursor: string | null;
}

export interface NoteConflict {
  conflict: true;
  code: 'stale_version';
  noteId: string;
  expectedVersion: number;
  currentVersion: number;
  attemptedRevisionId: string;
}

interface CurrentRow {
  id: string;
  version: number;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface RevisionRow {
  id: string;
  note_id: string;
  version: number;
  base_version: number | null;
  title: string;
  body: string;
  created_at: string;
  outcome: 'committed' | 'conflict' | 'pending';
}

function currentSql(where: string): string {
  return `SELECT n.id, n.version, r.title, r.body, n.created_at, n.updated_at, n.archived_at
    FROM note_current n
    JOIN note_revision r ON r.id = n.current_revision_id
    WHERE ${where}`;
}

function asNote(row: CurrentRow): Note {
  return {
    id: row.id,
    version: row.version,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function asText(value: JsonValue | undefined, field: string): string {
  if (!isJsonText(value)) throw new NoteError(400, `\`${field}\` must be a string`);
  return value;
}

function asVersion(value: JsonValue | undefined): number {
  if (!isJsonInteger(value, 1)) throw new NoteError(400, '`expectedVersion` must be a positive integer');
  return value;
}

function limitOf(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new NoteError(400, '`limit` must be a positive integer');
  return Math.min(value, MAX_LIMIT);
}

function encodeCursor(row: CurrentRow): string {
  return btoa(JSON.stringify({ updatedAt: row.updated_at, id: row.id }));
}

function decodeCursor(value: string | undefined): { updatedAt: string; id: string } | null {
  if (!value) return null;
  // `atob` throws on anything that is not base64, which `parseJson` cannot absorb
  // for it — the two failures are one refusal to the caller, so they share a catch.
  let decoded: JsonValue | undefined;
  try {
    decoded = parseJson(atob(value));
  } catch {
    decoded = undefined;
  }
  const parsed = isJsonRecord(decoded) ? decoded : undefined;
  const updatedAt = parsed?.updatedAt;
  const id = parsed?.id;
  if (!isJsonText(updatedAt) || !isJsonText(id)) throw new NoteError(400, 'invalid notes cursor');
  return { updatedAt, id };
}

export function noteExcerpt(markdown: string): string {
  const plain = markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*]|\d+\.)\s+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length <= 200 ? plain : `${plain.slice(0, 199).trimEnd()}…`;
}

function summary(row: CurrentRow): NoteSummary {
  const { body, ...note } = asNote(row);
  return { ...note, excerpt: noteExcerpt(body) };
}

export async function getNote(db: Db, id: string): Promise<Note | null> {
  if (!id) throw new NoteError(400, '`id` is required');
  const [row] = await db.all<CurrentRow>(currentSql('n.id = ?'), [id]);
  return row ? asNote(row) : null;
}

export async function listNotes(
  db: Db,
  options: { cursor?: string; limit?: number; archived?: boolean } = {},
): Promise<NotePage> {
  const limit = limitOf(options.limit);
  const cursor = decodeCursor(options.cursor);
  const archived = options.archived === true;
  const clauses = [archived ? 'n.archived_at IS NOT NULL' : 'n.archived_at IS NULL'];
  const params: (string | number | null)[] = [];
  if (cursor) {
    clauses.push('(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))');
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  params.push(limit + 1);
  const rows = await db.all<CurrentRow>(
    `${currentSql(clauses.join(' AND '))} ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`,
    params,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { notes: page.map(summary), nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
}

export async function searchNotes(
  db: Db,
  query: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<NotePage> {
  const match = toMatchQuery(query);
  if (!match) throw new NoteError(400, '`q` is required');
  const limit = limitOf(options.limit);
  const cursor = decodeCursor(options.cursor);
  const clauses = ['note_fts MATCH ?', 'n.archived_at IS NULL'];
  const params: (string | number | null)[] = [match];
  if (cursor) {
    clauses.push('(n.updated_at < ? OR (n.updated_at = ? AND n.id < ?))');
    params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
  }
  params.push(limit + 1);
  const rows = await db.all<CurrentRow>(
    `SELECT n.id, n.version, r.title, r.body, n.created_at, n.updated_at, n.archived_at
      FROM note_fts
      JOIN note_revision r ON r.id = note_fts.revision_id
      JOIN note_current n ON n.current_revision_id = r.id
      WHERE ${clauses.join(' AND ')}
      ORDER BY n.updated_at DESC, n.id DESC LIMIT ?`,
    params,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  return { notes: page.map(summary), nextCursor: more ? encodeCursor(page[page.length - 1]!) : null };
}

export async function createNote(db: Db, input: JsonRecord, now = new Date()): Promise<Note> {
  const title = asText(input.title, 'title');
  const body = asText(input.body, 'body');
  const id = crypto.randomUUID();
  const revisionId = crypto.randomUUID();
  const timestamp = now.toISOString();
  await db.batch([
    {
      sql: `INSERT INTO note_revision
        (id, note_id, version, base_version, title, body, created_at, outcome)
        VALUES (?, ?, 1, NULL, ?, ?, ?, 'committed')`,
      params: [revisionId, id, title, body, timestamp],
    },
    {
      sql: `INSERT INTO note_current
        (id, current_revision_id, version, created_at, updated_at, archived_at)
        VALUES (?, ?, 1, ?, ?, NULL)`,
      params: [id, revisionId, timestamp, timestamp],
    },
    { sql: 'INSERT INTO note_fts (revision_id, title, body) VALUES (?, ?, ?)', params: [revisionId, title, body] },
  ]);
  return (await getNote(db, id))!;
}

export async function updateNote(
  db: Db,
  id: string,
  input: JsonRecord,
  now = new Date(),
): Promise<{ note: Note; changed: boolean } | NoteConflict> {
  const expectedVersion = asVersion(input.expectedVersion);
  const current = await getNote(db, id);
  if (!current) throw new NoteError(404, `no note with id ${id}`);
  if (current.version !== expectedVersion) {
    const attemptedRevisionId = await retainConflict(db, current, input, expectedVersion, now);
    return stale(id, expectedVersion, current.version, attemptedRevisionId);
  }
  const title = input.title === undefined ? current.title : asText(input.title, 'title');
  const body = input.body === undefined ? current.body : asText(input.body, 'body');
  if (title === current.title && body === current.body) return { note: current, changed: false };

  const revisionId = crypto.randomUUID();
  const timestamp = now.toISOString();
  await db.batch([
    {
      sql: `INSERT INTO note_revision
        (id, note_id, version, base_version, title, body, created_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
      params: [revisionId, id, expectedVersion + 1, expectedVersion, title, body, timestamp],
    },
    { sql: 'INSERT INTO note_fts (revision_id, title, body) VALUES (?, ?, ?)', params: [revisionId, title, body] },
  ]);
  const applied = await db.run(
    `UPDATE note_current SET current_revision_id = ?, version = ?, updated_at = ?
      WHERE id = ? AND version = ?`,
    [revisionId, expectedVersion + 1, timestamp, id, expectedVersion],
  );
  if (applied.changes === 1) {
    await db.run("UPDATE note_revision SET outcome = 'committed' WHERE id = ?", [revisionId]);
    return { note: (await getNote(db, id))!, changed: true };
  }
  await db.run("UPDATE note_revision SET outcome = 'conflict' WHERE id = ?", [revisionId]);
  const latest = await getNote(db, id);
  return stale(id, expectedVersion, latest?.version ?? expectedVersion, revisionId);
}

async function retainConflict(
  db: Db,
  current: Note,
  input: JsonRecord,
  expectedVersion: number,
  now: Date,
): Promise<string> {
  const [expected] = await db.all<Pick<RevisionRow, 'title' | 'body'>>(
    `SELECT title, body FROM note_revision
      WHERE note_id = ? AND version = ? AND outcome = 'committed'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [current.id, expectedVersion],
  );
  const base = expected ?? current;
  const title = input.title === undefined ? base.title : asText(input.title, 'title');
  const body = input.body === undefined ? base.body : asText(input.body, 'body');
  const revisionId = crypto.randomUUID();
  await db.batch([
    {
      sql: `INSERT INTO note_revision
        (id, note_id, version, base_version, title, body, created_at, outcome)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'conflict')`,
      params: [revisionId, current.id, expectedVersion + 1, expectedVersion, title, body, now.toISOString()],
    },
    { sql: 'INSERT INTO note_fts (revision_id, title, body) VALUES (?, ?, ?)', params: [revisionId, title, body] },
  ]);
  return revisionId;
}

function stale(
  noteId: string,
  expectedVersion: number,
  currentVersion: number,
  attemptedRevisionId: string,
): NoteConflict {
  return { conflict: true, code: 'stale_version', noteId, expectedVersion, currentVersion, attemptedRevisionId };
}

export async function archiveNote(db: Db, id: string, now = new Date()): Promise<Note> {
  const result = await db.run('UPDATE note_current SET archived_at = ? WHERE id = ? AND archived_at IS NULL', [
    now.toISOString(),
    id,
  ]);
  const note = await getNote(db, id);
  if (!note) throw new NoteError(404, `no note with id ${id}`);
  return result.changes === 0 ? note : { ...note, archivedAt: now.toISOString() };
}

export async function restoreNote(db: Db, id: string): Promise<Note> {
  await db.run('UPDATE note_current SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL', [id]);
  const note = await getNote(db, id);
  if (!note) throw new NoteError(404, `no note with id ${id}`);
  return note;
}

export async function exportNotes(db: Db): Promise<string> {
  const notes = await db.all<{
    id: string;
    current_revision_id: string;
    version: number;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  }>('SELECT * FROM note_current ORDER BY created_at, id');
  const revisions = await db.all<RevisionRow>('SELECT * FROM note_revision ORDER BY created_at, id');
  return `${JSON.stringify({ version: 1, notes, revisions }, null, 2)}\n`;
}
