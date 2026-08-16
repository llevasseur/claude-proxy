export interface NoteMetadata {
  id: string;
  version: number;
  title: string;
  excerpt: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface NoteDocument extends Omit<NoteMetadata, 'excerpt'> {
  body: string;
}

export interface NotePage {
  notes: NoteMetadata[];
  nextCursor: string | null;
}

export interface NoteVersionConflict {
  conflict: true;
  code: 'stale_version';
  noteId: string;
  expectedVersion: number;
  currentVersion: number;
  attemptedRevisionId: string;
}

export type NoteSaveState =
  | { status: 'clean'; version: number }
  | { status: 'dirty'; version: number }
  | { status: 'saving'; version: number }
  | { status: 'conflict'; version: number; conflict: NoteVersionConflict }
  | { status: 'error'; version: number; message: string };

export interface NoteCreateInput {
  title: string;
  body: string;
}

export interface NoteUpdateInput {
  id: string;
  expectedVersion: number;
  title?: string;
  body?: string;
}

export interface NoteWriteResult {
  note: NoteDocument;
  changed?: boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error('expectedVersion must be a positive integer');
  return Number(value);
}

export function parseNoteCreate(value: unknown): NoteCreateInput {
  const input = record(value, 'request body');
  return { title: text(input.title, 'title'), body: text(input.body, 'body') };
}

export function parseNoteUpdate(value: unknown): NoteUpdateInput {
  const input = record(value, 'request body');
  const id = text(input.id, 'id');
  if (!id) throw new Error('id must not be blank');
  const result: NoteUpdateInput = { id, expectedVersion: positiveVersion(input.expectedVersion) };
  if (input.title !== undefined) result.title = text(input.title, 'title');
  if (input.body !== undefined) result.body = text(input.body, 'body');
  if (result.title === undefined && result.body === undefined) throw new Error('update needs title or body');
  return result;
}

export function parseNoteId(value: unknown): string {
  const input = record(value, 'request body');
  const id = text(input.id, 'id');
  if (!id) throw new Error('id must not be blank');
  return id;
}
