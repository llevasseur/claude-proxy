// The read routes answer under an open `*` CORS, which is only safe while they stay
// reads. The gate lives in the request dispatch, so these drive the real server over a
// socket rather than a handler stub.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { IdeaEntry, IdeaStatus } from '@claude-proxy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '../../proxy/json.ts';
import { openDb } from '../src/db/open.js';
import { closeRouteObservations, readRouteObservations } from '../src/db/route-observation-store.js';
import { addIdeasToStore } from '../src/ideas-store.js';
import { startFakeIdeasServer } from './ideas-fake-worker.js';
import { type FakeNotesServer, startFakeNotesServer } from './notes-fake-worker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'server.ts');
const PORT = 8801 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
/** A long-closed reporting day the corpus is seeded with, for the cache-control gate. */
const SETTLED_DAY = '2020-01-01';
/** The device system prompt this server edits — a temp file, never the real one. */
let promptPath: string;
/** This server's log directory, read back for the observations it records into. */
let logDir: string;
/**
 * The hosted ideas ledger, stood up on a real socket for the duration.
 *
 * The server under test runs as a child process, so the ledger it reads has to
 * be reachable over the network rather than stubbed in this process — and it
 * has to exist at all, since an unconfigured device now refuses the ideas
 * routes outright rather than falling back to a file. See ADR 0006.
 */
let ledger: { url: string; stop: () => Promise<void> };
let notes: FakeNotesServer;

interface RawReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * One request with no content negotiation but what the caller asks for. `fetch` sets
 * its own `accept-encoding` and transparently decompresses, which is the layer the
 * assertions at the bottom of this file are about.
 */
function raw(pathname: string, headers: Record<string, string> = {}, method = 'GET'): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** `Response.json()` answers `any`; these routes always reply with a `prompt` payload. */
async function promptOf(res: Response): Promise<JsonValue> {
  // SAFETY: every call site below hits `/api/system-prompt`, whose handlers
  // (buildSystemPrompt / buildSystemPromptUpdate) always reply `{ prompt: ... }` — the
  // cast only names the field this helper reads back out.
  return ((await res.json()) as { prompt: JsonValue }).prompt;
}

/** Poll `/api/health` until the listener answers, so a slow `tsx` start isn't a failure. */
async function waitForListening(deadlineMs = 30_000): Promise<void> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not start on ${BASE}`);
}

beforeAll(async () => {
  logDir = await mkdtemp(path.join(tmpdir(), 'route-methods-'));
  // Created here rather than left to the server's ingest, because the observation store
  // deliberately never creates a substrate — it only writes to one that already exists.
  openDb(logDir).close();
  // One archived request on a long-closed day, written **before** the server starts so
  // its ingest picks it up: the cache-control assertions below need a settled day the
  // corpus actually holds something for, which is the only kind vouched `immutable`.
  await mkdir(path.join(logDir, 'archive', SETTLED_DAY), { recursive: true });
  await writeFile(
    path.join(logDir, 'archive', SETTLED_DAY, `${SETTLED_DAY}T12-00-00-000_anthropic.audit.json`),
    JSON.stringify({
      timestamp: `${SETTLED_DAY}T12:00:00.000Z`,
      model: 'claude-opus-5',
      endpoint: 'POST /v1/messages',
      statusCode: 200,
      tokens: { input: 100, output: 50, cacheRead: 400, cacheCreation: 25, realInput: 500 },
      request: { toolCount: 0, toolsBytes: 0, systemBytes: 1200, totalBytes: 4000 },
      session: { sessionId: 'session-of-immutable', threadId: 'immutable' },
    }),
    'utf8',
  );
  promptPath = path.join(logDir, 'CLAUDE.md');
  ledger = await startFakeIdeasServer();
  notes = await startFakeNotesServer();
  process.env.IDEAS_URL = ledger.url;
  process.env.IDEAS_TOKEN = 'test-token';
  // Seeded so the ideas route below has a row to list and one to refuse a mark on.
  await addIdeasToStore([
    {
      slug: 'rolling-window',
      title: 'A rolling last-10 window beside the fixed buckets',
      rationale: 'The fixed windows split a habit that spans a boundary.',
      evidence: [{ source: 'open-question', path: 'docs/features/session-suggestions.md' }],
      repo: 'llevasseur/claude-proxy',
      area: 'ui-ux',
    },
  ]);
  child = spawn('npx', ['tsx', ENTRY], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      LOG_DIR: logDir,
      CLAUDE_SYSTEM_PROMPT: promptPath,
      NOTES_URL: notes.url,
      NOTES_TOKEN: notes.token,
      NOTES_POLL_MS: '50',
    },
    stdio: 'ignore',
  });
  await waitForListening();
}, 40_000);

afterAll(async () => {
  child?.kill();
  closeRouteObservations();
  await ledger?.stop();
  await notes?.stop();
});

describe('read routes', () => {
  it('refuses a POST rather than answering it under the open CORS', async () => {
    const res = await fetch(`${BASE}/api/withheld`, { method: 'POST' });

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, OPTIONS');
    expect(await res.json()).toEqual({ error: 'method not allowed: POST' });
  });

  it('refuses every other non-GET method too', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const res = await fetch(`${BASE}/api/filters`, { method });
      expect(res.status, method).toBe(405);
    }
  });

  it('still answers the GET it exists for', async () => {
    const res = await fetch(`${BASE}/api/withheld`);
    expect(res.status).toBe(200);
  });

  it('serves the system prompt as a GET, and refuses a save from a foreign origin', async () => {
    const read = await fetch(`${BASE}/api/system-prompt`);
    expect(read.status).toBe(200);
    expect(await promptOf(read)).toMatchObject({ path: promptPath, exists: false });

    // On the write allowlist, so the origin check owns it rather than the 405 gate.
    const foreign = await fetch(`${BASE}/api/system-prompt`, {
      method: 'POST',
      headers: { origin: 'http://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# owned\n' }),
    });
    expect(foreign.status).toBe(403);
  });

  it('writes the prompt through the save route', async () => {
    const res = await fetch(`${BASE}/api/system-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '# Device rules\r\n' }),
    });

    expect(res.status).toBe(200);
    expect(await promptOf(res)).toMatchObject({ exists: true, text: '# Device rules\n' });
    expect(await readFile(promptPath, 'utf8')).toBe('# Device rules\n');
  });

  it("refuses a save whose body isn't a string", async () => {
    const res = await fetch(`${BASE}/api/system-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 42 }),
    });

    expect(res.status).toBe(400);
  });

  it('lists the ideas ledger as a GET, and refuses every non-GET on it', async () => {
    const res = await fetch(`${BASE}/api/ideas`);
    expect(res.status).toBe(200);
    // SAFETY: `/api/ideas` is buildIdeas' list route, which always replies with a
    // `{ rows, meta: { counts } }` envelope — the cast only names that shape for this test.
    const body = (await res.json()) as { rows: IdeaEntry[]; meta: { counts: Record<IdeaStatus, number> } };
    expect(body.rows.map((r) => r.slug)).toEqual(['rolling-window']);
    expect(body.meta.counts.proposed).toBe(1);

    // The list is a read, so it keeps the open `*` CORS and its 405 gate — only
    // `/api/ideas/status` is on the write allowlist.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const refused = await fetch(`${BASE}/api/ideas`, { method });
      expect(refused.status, method).toBe(405);
      expect(refused.headers.get('allow'), method).toBe('GET, OPTIONS');
    }
  });

  it('adjudicates an idea through the write route, and maps each refusal to a 400', async () => {
    // `note` stays optional so the deliberately incomplete calls below can omit it.
    const mark = (marks: JsonValue, origin?: string) => {
      const body = JSON.stringify({ marks });
      return origin
        ? fetch(`${BASE}/api/ideas/status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body,
          })
        : fetch(`${BASE}/api/ideas/status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
          });
    };

    const accepted = await mark([{ slug: 'rolling-window', status: 'accepted' }]);
    expect(accepted.status).toBe(200);
    // SAFETY: `/api/ideas/status` always replies `{ rows }` on 200, whether it accepted,
    // rejected, or shipped the mark — the cast only names that envelope.
    expect((await accepted.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ status: 'accepted' }] });

    // Both notes are required: a rejection's reason, and a shipped mark's PR url.
    expect((await mark([{ slug: 'rolling-window', status: 'rejected' }])).status).toBe(400);
    expect((await mark([{ slug: 'rolling-window', status: 'shipped' }])).status).toBe(400);

    // On the write allowlist, so a declared foreign origin is refused outright.
    expect((await mark([{ slug: 'rolling-window', status: 'accepted' }], 'http://evil.example')).status).toBe(403);

    // Last, because it is terminal — re-shipping is then refused.
    const shipped = await mark([{ slug: 'rolling-window', status: 'shipped', note: 'https://x.test/1' }]);
    expect(shipped.status).toBe(200);
    // SAFETY: same `{ rows }` envelope as the accepted case above, now for the shipped mark.
    expect((await shipped.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ status: 'shipped' }] });
    expect((await mark([{ slug: 'rolling-window', status: 'shipped', note: 'https://x.test/2' }])).status).toBe(400);
  });

  it('files an idea and comments on it through their own write routes', async () => {
    // A JSON body for whichever of `area`/`comment` is named, malformed ones included.
    const post = (route: string, body: JsonValue, origin?: string) => {
      const jsonBody = JSON.stringify(body);
      return origin
        ? fetch(`${BASE}/api/ideas/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: jsonBody,
          })
        : fetch(`${BASE}/api/ideas/${route}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody,
          });
    };

    const filed = await post('area', { filings: [{ slug: 'rolling-window', area: 'services' }] });
    expect(filed.status).toBe(200);
    // SAFETY: `/api/ideas/area` always replies `{ rows }` on 200, same envelope as `/status`.
    expect((await filed.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ area: 'services' }] });

    const commented = await post('comment', { comments: [{ slug: 'rolling-window', text: 'start small' }] });
    expect(commented.status).toBe(200);
    // SAFETY: `/api/ideas/comment` replies the same `{ rows }` envelope, for the comment write.
    expect((await commented.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ comment: 'start small' }] });

    // Malformed input is a 400, and both routes are on the write allowlist, so a
    // declared foreign origin is refused before any of that.
    expect((await post('area', { filings: [{ slug: 'rolling-window', area: 'Not Kebab' }] })).status).toBe(400);
    expect((await post('comment', { comments: [{ slug: 'rolling-window' }] })).status).toBe(400);
    expect(
      (await post('area', { filings: [{ slug: 'rolling-window', area: 'services' }] }, 'http://evil.example')).status,
    ).toBe(403);
  });

  it('narrows the list by area, and refuses one that is not an area', async () => {
    // SAFETY: `/api/ideas` replies the same `{ rows }` list envelope whether or not it is
    // narrowed by `?area=` — only the query string that reaches it here varies.
    const rows = async (query: string) =>
      ((await (await fetch(`${BASE}/api/ideas${query}`)).json()) as { rows: IdeaEntry[] }).rows.map((r) => r.slug);

    expect(await rows('?area=services')).toEqual(['rolling-window']);
    expect(await rows('?area=ui-ux')).toEqual([]);
    expect((await fetch(`${BASE}/api/ideas?area=Not%20Kebab`)).status).toBe(400);
  });

  it('leaves the write allowlist to its own origin check', async () => {
    // Not 405: the write path owns this route's methods, and refuses a foreign origin
    // under its own origin-checked CORS.
    const res = await fetch(`${BASE}/api/chat/sessions`, {
      method: 'POST',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('proxies Notes reads with pagination while keeping the operator token out of responses', async () => {
    const list = await fetch(`${BASE}/api/notes?limit=1`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody).toMatchObject({
      notes: [{ id: 'note-1', version: 1, title: 'First note', excerpt: 'hosted Markdown' }],
      nextCursor: 'opaque-next',
    });
    const detail = await fetch(`${BASE}/api/notes/note?id=note-1`);
    const detailBody = await detail.json();
    expect(detailBody).toMatchObject({ note: { id: 'note-1', body: 'hosted Markdown' } });
    const search = await fetch(`${BASE}/api/notes/search?q=Markdown`);
    const searchBody = await search.json();
    expect(searchBody).toMatchObject({ notes: [{ id: 'note-1' }] });
    expect(JSON.stringify([listBody, detailBody, searchBody])).not.toContain(notes.token);
    expect(notes.requests.slice(-3).every((request) => request.authorization === `Bearer ${notes.token}`)).toBe(true);
  });

  it('origin-checks every Notes write and preserves upstream status and structured conflicts', async () => {
    // A JSON body for whichever Notes write route is named, incomplete ones included.
    const post = (path: string, body: JsonValue, origin?: string) => {
      const jsonBody = JSON.stringify(body);
      return origin
        ? fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin },
            body: jsonBody,
          })
        : fetch(`${BASE}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: jsonBody,
          });
    };
    expect((await post('/api/notes/create', { title: 'x', body: 'y' }, 'http://evil.example')).status).toBe(403);
    const created = await post('/api/notes/create', { title: '', body: '# exact' });
    expect(created.status).toBe(201);
    // SAFETY: `/api/notes/create` replies 201 with `{ note: { id, ... } }` on success, and
    // this line only runs after the 201 check above confirmed the create succeeded.
    const id = ((await created.json()) as { note: { id: string } }).note.id;
    expect((await post('/api/notes/update', { id, expectedVersion: 1 })).status).toBe(400);
    const updated = await post('/api/notes/update', { id, expectedVersion: 1, body: 'winner' });
    expect(updated.status).toBe(200);
    const conflict = await post('/api/notes/update', { id, expectedVersion: 1, body: 'loser' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      conflict: true,
      code: 'stale_version',
      expectedVersion: 1,
      currentVersion: 2,
      attemptedRevisionId: 'attempt-conflict',
    });
    expect((await post('/api/notes/archive', { id })).status).toBe(200);
    expect((await post('/api/notes/restore', { id })).status).toBe(200);
  });

  it('polls Notes metadata, drops unchanged snapshots, and emits an SSE update when a version changes', async () => {
    notes.set({ ...notes.note(), version: 2, updatedAt: '2026-08-16T12:00:00.000Z' });
    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/notes/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffered = '';
    const event = async (name: string): Promise<JsonObject> => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const frameEnd = buffered.indexOf('\n\n');
        if (frameEnd >= 0) {
          const frame = buffered.slice(0, frameEnd);
          buffered = buffered.slice(frameEnd + 2);
          if (frame.startsWith(`event: ${name}\n`)) {
            // SAFETY: the SSE writer in server/src/api.ts (Notes stream route) always
            // serializes a JSON object as each frame's `data:` line — the cast only
            // names that shape for the `notes`/`version` assertions below.
            return JSON.parse(frame.split('\ndata: ')[1]!) as JsonObject;
          }
          continue;
        }
        const next = await reader.read();
        if (next.done) break;
        buffered += decoder.decode(next.value, { stream: true });
      }
      throw new Error(`timed out waiting for ${name}`);
    };
    const snapshot = await event('snapshot');
    expect(snapshot).toMatchObject({ notes: [{ version: 2 }] });
    await new Promise((resolve) => setTimeout(resolve, 160));
    notes.set({ ...notes.note(), version: 3, updatedAt: '2026-08-16T13:00:00.000Z' });
    const update = await event('update');
    expect(update).toMatchObject({ notes: [{ version: 3 }] });
    controller.abort();
  });
});

/**
 * Transport, not payload: these assert the envelope around a JSON body rather than the
 * body itself.
 *
 * They share this file's server rather than standing up their own — a second `tsx`
 * process racing it for a cold start times both out under the full suite.
 */
describe('conditional and compressed reads', () => {
  /** Big enough to be worth gzipping. */
  const BIG_PROMPT = `${'# Device rules\n'.repeat(400)}`;

  beforeAll(async () => {
    const res = await fetch(`${BASE}/api/system-prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: BIG_PROMPT }),
    });
    expect(res.status).toBe(200);
  });

  it('tags a read with a validator and asks the client to revalidate', async () => {
    const res = await raw('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^W\/"[\w-]+"$/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers.vary).toBe('accept-encoding');
    expect(res.headers['content-length']).toBe(String(res.body.length));
  });

  /**
   * The one departure from the blanket `no-cache`, and both edges of it. A closed
   * reporting day the corpus holds requests for can never change again, so a browser is
   * told never to ask; the day in progress still can, and an *empty* past day only looks
   * settled — an archive restore or a rebuild can give it content, and nothing on the
   * server could then reach an `immutable` entry to correct it.
   */
  it('answers a settled non-empty day as immutable, and an empty or open day as no-cache', async () => {
    const settled = await raw(`/api/context/day?date=${SETTLED_DAY}`);
    expect(settled.status).toBe(200);
    expect(settled.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(settled.headers.etag).toMatch(/^W\/"[\w-]+"$/);

    // Closed by date, but the corpus holds nothing for it — so it is not vouched for.
    const empty = await raw('/api/context/day?date=2019-01-01');
    expect(empty.status).toBe(200);
    expect(empty.headers['cache-control']).toBe('no-cache');

    const open = await raw('/api/context/day');
    expect(open.status).toBe(200);
    expect(open.headers['cache-control']).toBe('no-cache');
  });

  it('answers an unchanged poll with a bodyless 304 that still validates', async () => {
    const first = await raw('/api/health');
    const etag = first.headers.etag!;

    const second = await raw('/api/health', { 'if-none-match': etag });

    expect(second.status).toBe(304);
    expect(second.body.length).toBe(0);
    expect(second.headers.etag).toBe(etag);
    expect(second.headers['access-control-allow-origin']).toBe('*');
    expect(second.headers['content-length']).toBeUndefined();
  });

  it('matches a strong tag, an entry in a list, and `*`, but not a stale one', async () => {
    const etag = (await raw('/api/health')).headers.etag!;

    expect((await raw('/api/health', { 'if-none-match': etag.replace(/^W\//, '') })).status).toBe(304);
    expect((await raw('/api/health', { 'if-none-match': `"nope", ${etag}` })).status).toBe(304);
    expect((await raw('/api/health', { 'if-none-match': '*' })).status).toBe(304);
    expect((await raw('/api/health', { 'if-none-match': '"stale"' })).status).toBe(200);
  });

  it('compresses a body worth compressing, and sends the identical payload either way', async () => {
    const plain = await raw('/api/system-prompt', { 'accept-encoding': 'identity' });
    const zipped = await raw('/api/system-prompt', { 'accept-encoding': 'gzip, br' });

    expect(plain.body.length).toBeGreaterThan(1024);
    expect(plain.headers['content-encoding']).toBeUndefined();

    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.headers['content-length']).toBe(String(zipped.body.length));
    expect(zipped.body.length).toBeLessThan(plain.body.length);
    // Same payload either way, so the validator is a function of the body, not the encoding.
    expect(gunzipSync(zipped.body).toString('utf8')).toBe(plain.body.toString('utf8'));
    expect(zipped.headers.etag).toBe(plain.headers.etag);
  });

  it('leaves a small body, and a caller that refuses gzip, uncompressed', async () => {
    const small = await raw('/api/health', { 'accept-encoding': 'gzip' });
    expect(small.body.length).toBeLessThan(1024);
    expect(small.headers['content-encoding']).toBeUndefined();

    const refused = await raw('/api/system-prompt', { 'accept-encoding': 'gzip;q=0' });
    expect(refused.body.length).toBeGreaterThan(1024);
    expect(refused.headers['content-encoding']).toBeUndefined();
  });

  it('leaves errors, the method gate and the preflight as they were', async () => {
    const method = await raw('/api/filters', {}, 'POST');
    expect(method.status).toBe(405);
    expect(method.headers.allow).toBe('GET, OPTIONS');
    // No validator on a body nothing should be caching.
    expect(method.headers.etag).toBeUndefined();
    expect(JSON.parse(method.body.toString('utf8'))).toEqual({ error: 'method not allowed: POST' });

    const missing = await raw('/api/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.etag).toBeUndefined();

    const preflight = await raw('/api/health', {}, 'OPTIONS');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toBe('GET, OPTIONS');
  });

  it('keeps varying on the origin where the chat CORS already did', async () => {
    const res = await raw('/api/chat/stream?sessionId=nope', { origin: 'http://evil.example' });

    expect(res.status).toBe(403);
    expect(res.headers.vary).toBe('origin, accept-encoding');
  });
});

/**
 * The measurement half of the route budgets, driven over the socket.
 *
 * `observeServedRoute` and the `servedBytes` map are private to `server.ts`, and what is
 * worth asserting is not their arithmetic but their wiring: that a served 200 leaves a row,
 * and that the paths which never reach `send` leave none. Those exclusions hold *by
 * construction* rather than by a list of status codes, and construction is exactly what a
 * later refactor of `send` can quietly break with the suite still green.
 */
describe('what a served response records', () => {
  /** Rows the substrate holds for one route, read through the store's read-only handle. */
  const rows = (route: string): number => readRouteObservations(logDir).filter((o) => o.route === route).length;

  /**
   * The insert happens on `finish`, so an observation can trail the response that caused it.
   * Bounded well inside the test timeout: a row that has not landed in two seconds is a
   * failed assertion worth reading, not a test that ran out of time with nothing to say.
   */
  async function settle(route: string, atLeast: number): Promise<number> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      if (rows(route) >= atLeast) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    return rows(route);
  }

  it('records one observation for a 200 that wrote a body', async () => {
    const before = rows('/api/health');

    expect((await raw('/api/health')).status).toBe(200);

    expect(await settle('/api/health', before + 1)).toBe(before + 1);
  });

  it('records nothing for a 304, which measures the ETag comparison rather than the work', async () => {
    // Counted before the request that earns the validator, since that request records too.
    const priming = rows('/api/health');
    const etag = (await raw('/api/health')).headers.etag!;
    const before = await settle('/api/health', priming + 1);

    expect((await raw('/api/health', { 'if-none-match': etag })).status).toBe(304);

    // Long enough that a recorded 304 would have landed: the insert is synchronous inside
    // the `finish` handler the response before it already demonstrated.
    await new Promise((r) => setTimeout(r, 300));
    expect(rows('/api/health')).toBe(before);
  });

  it('records nothing for a 405, which is refused before the observation is even wired', async () => {
    const before = rows('/api/filters');

    expect((await raw('/api/filters', {}, 'POST')).status).toBe(405);

    await new Promise((r) => setTimeout(r, 300));
    expect(rows('/api/filters')).toBe(before);
  });

  it('records nothing for an SSE subscription, which writes its frames and never reaches send', async () => {
    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/notes/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    controller.abort();

    // A stream carries no single answer to size, so there is nothing a budget could judge.
    await new Promise((r) => setTimeout(r, 300));
    expect(rows('/api/notes/stream')).toBe(0);
  });
});
