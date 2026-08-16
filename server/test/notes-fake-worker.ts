import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NoteDocument, NoteMetadata, NotePage } from '@claude-proxy/core';

export interface FakeNotesServer {
  url: string;
  token: string;
  requests: { method: string; path: string; authorization?: string }[];
  note: () => NoteDocument;
  set: (note: NoteDocument) => void;
  stop: () => Promise<void>;
}

const TOKEN = 'fake-notes-token';

function summary(note: NoteDocument): NoteMetadata {
  const { body: _body, ...metadata } = note;
  return { ...metadata, excerpt: note.body.slice(0, 200) };
}

export async function startFakeNotesServer(): Promise<FakeNotesServer> {
  let note: NoteDocument = {
    id: 'note-1',
    version: 1,
    title: 'First note',
    body: 'hosted Markdown',
    createdAt: '2026-08-16T10:00:00.000Z',
    updatedAt: '2026-08-16T10:00:00.000Z',
    archivedAt: null,
  };
  const requests: FakeNotesServer['requests'] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authorization = req.headers.authorization;
    requests.push({ method: req.method ?? 'GET', path: `${url.pathname}${url.search}`, authorization });
    if (authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.method === 'GET' && url.pathname === '/api/notes') {
        const archived = url.searchParams.get('archived') === 'true';
        const notes = Boolean(note.archivedAt) === archived ? [summary(note)] : [];
        const page: NotePage = { notes, nextCursor: url.searchParams.get('limit') === '1' ? 'opaque-next' : null };
        send(200, page);
      } else if (req.method === 'GET' && url.pathname === '/api/notes/search') {
        const matches = `${note.title} ${note.body}`
          .toLowerCase()
          .includes((url.searchParams.get('q') ?? '').toLowerCase());
        send(200, { notes: matches && !note.archivedAt ? [summary(note)] : [], nextCursor: null });
      } else if (req.method === 'GET' && url.pathname === '/api/notes/note') {
        send(
          url.searchParams.get('id') === note.id ? 200 : 404,
          url.searchParams.get('id') === note.id ? { note } : { error: 'not found' },
        );
      } else if (req.method === 'POST' && url.pathname === '/api/notes') {
        note = { ...note, id: 'note-created', version: 1, title: String(body.title), body: String(body.body) };
        send(201, { note });
      } else if (req.method === 'POST' && url.pathname === '/api/notes/update') {
        if (body.expectedVersion !== note.version) {
          send(409, {
            conflict: true,
            code: 'stale_version',
            noteId: note.id,
            expectedVersion: body.expectedVersion,
            currentVersion: note.version,
            attemptedRevisionId: 'attempt-conflict',
          });
        } else {
          note = {
            ...note,
            version: note.version + 1,
            ...(body.title === undefined ? {} : { title: String(body.title) }),
            ...(body.body === undefined ? {} : { body: String(body.body) }),
          };
          send(200, { note, changed: true });
        }
      } else if (req.method === 'POST' && url.pathname === '/api/notes/archive') {
        note = { ...note, archivedAt: '2026-08-16T12:00:00.000Z' };
        send(200, { note });
      } else if (req.method === 'POST' && url.pathname === '/api/notes/restore') {
        note = { ...note, archivedAt: null };
        send(200, { note });
      } else {
        send(404, { error: `no route for ${req.method} ${url.pathname}` });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    requests,
    note: () => note,
    set: (next) => {
      note = next;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
