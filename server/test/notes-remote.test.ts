import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteNote,
  listRemoteNotes,
  NotesStoreUnconfiguredError,
  RemoteNotesResponseError,
  requireRemoteNotesStore,
  searchRemoteNotes,
  updateRemoteNote,
} from '../src/notes-remote.ts';

const ORIGIN = 'https://operator.example.workers.dev';
const TOKEN = 'notes-token-never-in-browser';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function configure(): void {
  vi.stubEnv('NOTES_URL', ORIGIN);
  vi.stubEnv('NOTES_TOKEN', TOKEN);
}

function reply(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', mock);
  return mock;
}

describe('notes remote configuration', () => {
  it('is required and has no local fallback', () => {
    vi.stubEnv('NOTES_URL', '');
    vi.stubEnv('NOTES_TOKEN', '');
    vi.stubEnv('CONCEPTS_URL', '');
    vi.stubEnv('CONCEPTS_TOKEN', '');
    expect(() => requireRemoteNotesStore()).toThrow(NotesStoreUnconfiguredError);
    expect(() => requireRemoteNotesStore()).toThrow(/no local fallback/);
  });

  it('uses the shared operator configuration when Notes-specific values are absent', () => {
    vi.stubEnv('CONCEPTS_URL', `${ORIGIN}/`);
    vi.stubEnv('CONCEPTS_TOKEN', TOKEN);
    expect(requireRemoteNotesStore()).toEqual({ origin: ORIGIN, token: TOKEN });
  });
});

describe('notes remote calls', () => {
  it('keeps authorization server-side and forwards opaque pagination', async () => {
    configure();
    const fetchMock = reply({ notes: [], nextCursor: null });
    const result = await listRemoteNotes(requireRemoteNotesStore(), { cursor: 'opaque+cursor', limit: 20 });
    expect(result.body).toEqual({ notes: [], nextCursor: null });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/notes?cursor=opaque%2Bcursor&limit=20`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('forwards search and preserves create status', async () => {
    configure();
    const fetchMock = reply({ note: { id: 'note-1' } }, 201);
    expect((await createRemoteNote(requireRemoteNotesStore(), { title: '', body: '# body' })).status).toBe(201);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`${ORIGIN}/api/notes`);
    const [, createInit] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(JSON.parse(String(createInit.body))).toEqual({
      title: '',
      body: '# body',
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ notes: [], nextCursor: null })));
    await searchRemoteNotes(requireRemoteNotesStore(), { query: 'two words', cursor: 'next' });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${ORIGIN}/api/notes/search?q=two+words&cursor=next`);
  });

  it('preserves a structured 409 conflict without parsing its message', async () => {
    configure();
    const conflict = {
      conflict: true,
      code: 'stale_version',
      noteId: 'note-1',
      expectedVersion: 1,
      currentVersion: 2,
      attemptedRevisionId: 'attempt-2',
    };
    reply(conflict, 409);
    const error = await updateRemoteNote(requireRemoteNotesStore(), {
      id: 'note-1',
      expectedVersion: 1,
      body: 'mine',
    }).catch((reason: unknown) => reason as RemoteNotesResponseError);
    expect(error).toBeInstanceOf(RemoteNotesResponseError);
    expect(error).toMatchObject({ status: 409, body: conflict });
  });

  it('redacts the token even if an upstream response accidentally echoes it', async () => {
    configure();
    reply({ error: `bad bearer ${TOKEN}` }, 500);
    const error = await listRemoteNotes(requireRemoteNotesStore()).catch(
      (reason: unknown) => reason as RemoteNotesResponseError,
    );
    expect(JSON.stringify(error.body)).not.toContain(TOKEN);
    expect(error.body).toEqual({ error: 'bad bearer [redacted]' });
  });
});
