// The read routes answer under an open `*` CORS, which is only safe while they stay
// reads. The gate lives in the request dispatch, so these drive the real server over a
// socket rather than a handler stub.
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IdeaEntry, IdeaStatus } from '@claude-proxy/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addIdeasToStore } from '../src/ideas-store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'src', 'server.ts');
const PORT = 8801 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

let child: ChildProcess;
/** The device system prompt this server edits — a temp file, never the real one. */
let promptPath: string;

/** `Response.json()` answers `unknown`; these routes always reply with a `prompt` payload. */
async function promptOf(res: Response): Promise<unknown> {
  return ((await res.json()) as { prompt: unknown }).prompt;
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
  const logDir = await mkdtemp(path.join(tmpdir(), 'route-methods-'));
  promptPath = path.join(logDir, 'CLAUDE.md');
  // Seeded so the ideas route below has a row to list and one to refuse a mark on.
  await addIdeasToStore(logDir, [
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
    },
    stdio: 'ignore',
  });
  await waitForListening();
}, 40_000);

afterAll(() => {
  child?.kill();
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
    const mark = (marks: unknown, origin?: string) =>
      fetch(`${BASE}/api/ideas/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify({ marks }),
      });

    const accepted = await mark([{ slug: 'rolling-window', status: 'accepted' }]);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ status: 'accepted' }] });

    // `shipped` carries a PR url, so it stays with the CLI; a rejection needs its reason.
    expect((await mark([{ slug: 'rolling-window', status: 'shipped', note: 'https://x.test/1' }])).status).toBe(400);
    expect((await mark([{ slug: 'rolling-window', status: 'rejected' }])).status).toBe(400);

    // On the write allowlist, so a declared foreign origin is refused outright.
    expect((await mark([{ slug: 'rolling-window', status: 'accepted' }], 'http://evil.example')).status).toBe(403);
  });

  it('files an idea and comments on it through their own write routes', async () => {
    const post = (route: string, body: unknown, origin?: string) =>
      fetch(`${BASE}/api/ideas/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });

    const filed = await post('area', { filings: [{ slug: 'rolling-window', area: 'services' }] });
    expect(filed.status).toBe(200);
    expect((await filed.json()) as { rows: IdeaEntry[] }).toMatchObject({ rows: [{ area: 'services' }] });

    const commented = await post('comment', { comments: [{ slug: 'rolling-window', text: 'start small' }] });
    expect(commented.status).toBe(200);
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
});
