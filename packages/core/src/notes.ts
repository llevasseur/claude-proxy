import { type JsonObject, type JsonValue, jsonNumber, jsonObject, jsonText, jsonValueOf } from './json.js';

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

/** The member map `value` is, or a refusal naming what was expected. */
function fields(value: JsonValue, label: string): JsonObject {
  const found = jsonObject(value);
  if (found === null) throw new Error(`${label} must be an object`);
  return found;
}

/** The string `value` is, or a refusal naming the field that was not one. */
function text(value: JsonValue | undefined, label: string): string {
  const found = jsonText(value);
  if (found === null) throw new Error(`${label} must be a string`);
  return found;
}

/** A version counter: an integer of at least 1, or a refusal. */
function positiveVersion(value: JsonValue | undefined): number {
  const version = jsonNumber(value);
  if (version === null || !Number.isInteger(version) || version < 1)
    throw new Error('expectedVersion must be a positive integer');
  return version;
}

/** Read a request body as a note creation, or throw with the first thing wrong. */
export function parseNoteCreate<Candidate>(value: Candidate): NoteCreateInput {
  const input = fields(jsonValueOf(value), 'request body');
  return { title: text(input.title, 'title'), body: text(input.body, 'body') };
}

/** Read a request body as a note revision, or throw with the first thing wrong. */
export function parseNoteUpdate<Candidate>(value: Candidate): NoteUpdateInput {
  const input = fields(jsonValueOf(value), 'request body');
  const id = text(input.id, 'id');
  if (!id) throw new Error('id must not be blank');
  const result: NoteUpdateInput = { id, expectedVersion: positiveVersion(input.expectedVersion) };
  if (input.title !== undefined) result.title = text(input.title, 'title');
  if (input.body !== undefined) result.body = text(input.body, 'body');
  if (result.title === undefined && result.body === undefined) throw new Error('update needs title or body');
  return result;
}

/** Read a request body as the id of one note, or throw with the first thing wrong. */
export function parseNoteId<Candidate>(value: Candidate): string {
  const input = fields(jsonValueOf(value), 'request body');
  const id = text(input.id, 'id');
  if (!id) throw new Error('id must not be blank');
  return id;
}
