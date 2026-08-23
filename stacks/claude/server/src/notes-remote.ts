import type {
  NoteCreateInput,
  NoteDocument,
  NotePage,
  NoteUpdateInput,
  NoteVersionConflict,
  NoteWriteResult,
} from '@agent-proxy/claude-core';
import { errorMessage } from './errors.js';
import { type JsonValue, parseJson } from './json.js';

export interface RemoteNotesStore {
  origin: string;
  token: string;
}

export interface RemoteNotesReply<T> {
  status: number;
  body: T;
}

export class NotesStoreUnconfiguredError extends Error {
  constructor() {
    super(
      'this device has no notes store configured: set NOTES_URL and NOTES_TOKEN (or CONCEPTS_URL and CONCEPTS_TOKEN) to the operator Worker. There is deliberately no local fallback.',
    );
    this.name = 'NotesStoreUnconfiguredError';
  }
}

export class RemoteNotesStoreError extends Error {
  constructor(message: string) {
    super(`notes store unreachable: ${message}`);
    this.name = 'RemoteNotesStoreError';
  }
}

export class RemoteNotesResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: JsonValue,
    label: string,
  ) {
    super(`notes store refused ${label} with ${status}`);
    this.name = 'RemoteNotesResponseError';
  }
}

export function requireRemoteNotesStore(): RemoteNotesStore {
  const origin = (process.env.NOTES_URL ?? process.env.CONCEPTS_URL)?.trim();
  const token = (process.env.NOTES_TOKEN ?? process.env.CONCEPTS_TOKEN)?.trim();
  if (!origin || !token) throw new NotesStoreUnconfiguredError();
  return { origin: origin.replace(/\/+$/, ''), token };
}

function safeLabel(requested: string, fallbackPath: string): string {
  try {
    const url = new URL(requested);
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallbackPath;
  }
}

/** Every query this module sends: flat scalars, each one optional. */
interface NoteQueryParams {
  id?: string;
  q?: string;
  query?: string;
  cursor?: string;
  limit?: number;
  archived?: boolean;
}

function query(path: string, params: NoteQueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function decodedBody(text: string, token: string, label: string): JsonValue {
  const redacted = text.split(token).join('[redacted]');
  // `parseJson` answers `undefined` for exactly the input `JSON.parse` throws on,
  // and `undefined` is not a value any well-formed document can hold.
  const value = parseJson(redacted);
  if (value === undefined) throw new RemoteNotesStoreError(`${label} returned invalid JSON`);
  return value;
}

function redactedReason(cause: unknown, token: string): string {
  return errorMessage(cause).split(token).join('[redacted]');
}

/** The headers this module sets itself, before `init`'s own are laid over them. */
interface CallHeaders {
  authorization: string;
  'content-type'?: string;
}

async function call<T>(store: RemoteNotesStore, path: string, init?: RequestInit): Promise<RemoteNotesReply<T>> {
  const requested = `${store.origin}${path}`;
  const label = safeLabel(requested, path.split('?')[0] ?? path);
  // `content-type` is set only for a request that carries a body, and `init`'s
  // own headers still win over both, exactly as the spread they replace did.
  const headers: CallHeaders = { authorization: `Bearer ${store.token}` };
  if (init?.body) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(requested, {
      ...init,
      headers: { ...headers, ...init?.headers },
    });
  } catch (cause) {
    throw new RemoteNotesStoreError(`${label} (${redactedReason(cause, store.token)})`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (cause) {
    throw new RemoteNotesStoreError(`${label} (${redactedReason(cause, store.token)})`);
  }
  const body = decodedBody(text, store.token, label);
  if (!response.ok) throw new RemoteNotesResponseError(response.status, body, label);
  // SAFETY: `T` is the shape the caller names for the route it asked for, and
  // every caller is one of this file's own wrappers, each paired with the notes
  // route that answers it. The 2xx check above is what says the store answered
  // with that shape rather than with a refusal.
  return { status: response.status, body: body as T };
}

/** The bodies this module posts: the two write inputs, or a bare note id. */
type NoteRequestBody = NoteCreateInput | NoteUpdateInput | { id: string };

function post<T>(store: RemoteNotesStore, path: string, body: NoteRequestBody): Promise<RemoteNotesReply<T>> {
  return call<T>(store, path, { method: 'POST', body: JSON.stringify(body) });
}

export interface NoteListQuery {
  cursor?: string;
  limit?: number;
  archived?: boolean;
}

export interface NoteSearchQuery extends Omit<NoteListQuery, 'archived'> {
  query: string;
}

export function listRemoteNotes(
  store: RemoteNotesStore,
  options: NoteListQuery = {},
): Promise<RemoteNotesReply<NotePage>> {
  return call<NotePage>(store, query('/api/notes', options));
}

export function searchRemoteNotes(
  store: RemoteNotesStore,
  options: NoteSearchQuery,
): Promise<RemoteNotesReply<NotePage>> {
  return call<NotePage>(
    store,
    query('/api/notes/search', { q: options.query, cursor: options.cursor, limit: options.limit }),
  );
}

export function getRemoteNote(store: RemoteNotesStore, id: string): Promise<RemoteNotesReply<{ note: NoteDocument }>> {
  return call<{ note: NoteDocument }>(store, query('/api/notes/note', { id }));
}

export function createRemoteNote(
  store: RemoteNotesStore,
  input: NoteCreateInput,
): Promise<RemoteNotesReply<NoteWriteResult>> {
  return post<NoteWriteResult>(store, '/api/notes', input);
}

export function updateRemoteNote(
  store: RemoteNotesStore,
  input: NoteUpdateInput,
): Promise<RemoteNotesReply<NoteWriteResult | NoteVersionConflict>> {
  return post<NoteWriteResult | NoteVersionConflict>(store, '/api/notes/update', input);
}

export function archiveRemoteNote(store: RemoteNotesStore, id: string): Promise<RemoteNotesReply<NoteWriteResult>> {
  return post<NoteWriteResult>(store, '/api/notes/archive', { id });
}

export function restoreRemoteNote(store: RemoteNotesStore, id: string): Promise<RemoteNotesReply<NoteWriteResult>> {
  return post<NoteWriteResult>(store, '/api/notes/restore', { id });
}
