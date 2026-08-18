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
import { errorMessage, isJsonRecord, type JsonValue, numberField, readJsonBody, textField } from './json';

export class NotesApiError extends Error {
  constructor(
    readonly status: number,
    /** The parsed failing body, kept whole so `noteConflict` can read the 409 payload out of it. */
    readonly body: JsonValue | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'NotesApiError';
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new NotesApiError(response.status, body, errorMessage(body) ?? `HTTP ${response.status}`);
  }
  // SAFETY: `T` comes from the four call sites below, each of which names the return type
  // of the one `/api/notes/*` route it fetches — `NotePage`, `NoteDocument`, `NoteWriteResult`.
  // The server builds those bodies from the same `@claude-proxy/core` types imported above,
  // so the assertion is the shared declaration rather than a claim made about this response.
  return body as T;
}

/**
 * `Body` is inferred from the caller's input type — `NoteCreateInput`, `NoteUpdateInput`, or
 * the small id literals below — so the payload is checked at the call site, not erased here.
 */
async function post<T, Body>(path: string, body: Body): Promise<T> {
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

/**
 * The stale-version report behind a failed save, or `null` when the failure was anything
 * else. Read field by field rather than handed through: only `409` bodies flagged
 * `conflict` reach the caller, and the versions it renders arrive as real numbers.
 */
export function noteConflict(error: Error | null): NoteVersionConflict | null {
  if (!(error instanceof NotesApiError) || error.status !== 409) return null;
  const body = error.body;
  if (!isJsonRecord(body) || body.conflict !== true) return null;
  return {
    conflict: true,
    code: 'stale_version',
    noteId: textField(body, 'noteId') ?? '',
    expectedVersion: numberField(body, 'expectedVersion') ?? 0,
    currentVersion: numberField(body, 'currentVersion') ?? 0,
    attemptedRevisionId: textField(body, 'attemptedRevisionId') ?? '',
  };
}
