import type {
  NoteCreateInput,
  NoteDocument,
  NotePage,
  NoteUpdateInput,
  NoteVersionConflict,
  NoteWriteResult,
} from '@claude-proxy/core';

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
    public readonly body: unknown,
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

function query(path: string, params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params) as [string, string | number | boolean | undefined][]) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const suffix = search.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function decodedBody(text: string, token: string, label: string): unknown {
  const redacted = text.split(token).join('[redacted]');
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    throw new RemoteNotesStoreError(`${label} returned invalid JSON`);
  }
}

function redactedReason(error: unknown, token: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(token).join('[redacted]');
}

async function call<T>(store: RemoteNotesStore, path: string, init?: RequestInit): Promise<RemoteNotesReply<T>> {
  const requested = `${store.origin}${path}`;
  const label = safeLabel(requested, path.split('?')[0] ?? path);
  let response: Response;
  try {
    response = await fetch(requested, {
      ...init,
      headers: {
        authorization: `Bearer ${store.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new RemoteNotesStoreError(`${label} (${redactedReason(error, store.token)})`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new RemoteNotesStoreError(`${label} (${redactedReason(error, store.token)})`);
  }
  const body = decodedBody(text, store.token, label);
  if (!response.ok) throw new RemoteNotesResponseError(response.status, body, label);
  return { status: response.status, body: body as T };
}

function post<T>(store: RemoteNotesStore, path: string, body: unknown): Promise<RemoteNotesReply<T>> {
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
