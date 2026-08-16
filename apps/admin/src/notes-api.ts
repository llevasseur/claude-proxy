import type {
  NoteCreateInput,
  NoteDocument,
  NotePage,
  NoteUpdateInput,
  NoteVersionConflict,
  NoteWriteResult,
} from '@claude-proxy/core';
import { apiRouteUrl } from '@claude-proxy/core';
import { API_BASE } from './api';

export class NotesApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'NotesApiError';
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
        ? body.error
        : `HTTP ${response.status}`;
    throw new NotesApiError(response.status, body, message);
  }
  return body as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  return responseJson<T>(
    await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export function listNotes(options: { cursor?: string; archived?: boolean } = {}): Promise<NotePage> {
  return fetch(
    `${API_BASE}${apiRouteUrl('/api/notes', { cursor: options.cursor, limit: 50, archived: options.archived })}`,
  ).then(responseJson<NotePage>);
}

export function searchNotes(query: string, cursor?: string): Promise<NotePage> {
  return fetch(`${API_BASE}${apiRouteUrl('/api/notes/search', { q: query, cursor, limit: 50 })}`).then(
    responseJson<NotePage>,
  );
}

export function getNote(id: string): Promise<NoteDocument> {
  return fetch(`${API_BASE}${apiRouteUrl('/api/notes/note', { id })}`)
    .then(responseJson<{ note: NoteDocument }>)
    .then(({ note }) => note);
}

export const createNote = (input: NoteCreateInput): Promise<NoteWriteResult> => post('/api/notes/create', input);
export const updateNote = (input: NoteUpdateInput): Promise<NoteWriteResult> => post('/api/notes/update', input);
export const archiveNote = (id: string): Promise<NoteWriteResult> => post('/api/notes/archive', { id });
export const restoreNote = (id: string): Promise<NoteWriteResult> => post('/api/notes/restore', { id });

export function noteConflict(error: unknown): NoteVersionConflict | null {
  if (!(error instanceof NotesApiError) || error.status !== 409) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null || !('conflict' in body)) return null;
  return body as NoteVersionConflict;
}
