/**
 * An in-memory stand-in for the hosted ideas ledger, installed over `fetch`.
 *
 * **This is not where the ledger's rules are tested.** Those live in
 * `services/concepts/src/ideas.ts` and are exercised against real SQLite in
 * `services/concepts/test/ideas.test.ts` — replay order, the atomic claim, the
 * TTL boundary, cross-corpus dedupe. The suites *here* test this side of the
 * wire: the refusals `server/src/api.ts` enforces before a write is sent, the
 * shapes the CLI prints, the PR reconciler's reading of the store. Those need a
 * ledger that answers, not a ledger that is also under test.
 *
 * It drives the same `packages/core` apply functions both real implementations
 * use, which is what stops it from being a *different* ledger.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  applyIdeaAdds,
  applyIdeaClaims,
  applyIdeaComments,
  applyIdeaFilings,
  applyIdeaMarks,
  emptyIdeasStore,
  type IdeasStore,
  similarAreas,
  similarIdeaSlugs,
} from '@claude-proxy/core';

export interface FakeIdeasWorker {
  /** The ledger as it currently stands, for a test that wants to assert on it directly. */
  store: () => IdeasStore;
  /** Seed it without going through HTTP. */
  set: (store: IdeasStore) => void;
  /** Restore the real `fetch` and the environment. */
  restore: () => void;
}

const ORIGIN = 'https://ledger.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** One mutable ledger, and the routes over it. Shared by both ways of exposing it. */
interface Ledger {
  get: () => IdeasStore;
  set: (store: IdeasStore) => void;
  handle: (pathname: string, body: Record<string, unknown>) => { status: number; payload: unknown };
}

function ledger(): Ledger {
  let store = emptyIdeasStore();
  const now = () => new Date();
  return {
    get: () => store,
    set: (next) => {
      store = next;
    },
    handle(pathname, body) {
      if (pathname === '/api/ideas/export') return { status: 200, payload: store };

      if (pathname === '/api/ideas') {
        const adds = (body.ideas ?? []) as Parameters<typeof applyIdeaAdds>[1];
        const similar: Record<string, string[]> = {};
        const areaHits: Record<string, string[]> = {};
        for (const add of adds) {
          const hits = similarIdeaSlugs(store, add.slug);
          if (hits.length > 0) similar[add.slug] = hits;
          const areas = similarAreas(store, add.area);
          if (areas.length > 0) areaHits[add.slug] = areas;
        }
        const result = applyIdeaAdds(store, adds, now());
        store = result.store;
        return {
          status: 200,
          payload: { added: result.added, refused: result.refused, similar, similarAreas: areaHits },
        };
      }

      if (pathname === '/api/ideas/mark') {
        const result = applyIdeaMarks(store, (body.marks ?? []) as Parameters<typeof applyIdeaMarks>[1], now());
        store = result.store;
        return { status: 200, payload: { updated: result.updated, unknown: result.unknown } };
      }

      if (pathname === '/api/ideas/file') {
        try {
          const result = applyIdeaFilings(store, (body.filings ?? []) as Parameters<typeof applyIdeaFilings>[1], now());
          store = result.store;
          return { status: 200, payload: { updated: result.updated, unknown: result.unknown } };
        } catch (error) {
          return { status: 400, payload: { error: (error as Error).message } };
        }
      }

      if (pathname === '/api/ideas/comment') {
        const result = applyIdeaComments(
          store,
          (body.comments ?? []) as Parameters<typeof applyIdeaComments>[1],
          now(),
        );
        store = result.store;
        return { status: 200, payload: { updated: result.updated, unknown: result.unknown } };
      }

      if (pathname === '/api/ideas/claim') {
        const result = applyIdeaClaims(store, (body.claims ?? []) as Parameters<typeof applyIdeaClaims>[1], now());
        store = result.store;
        return {
          status: 200,
          payload: { claimed: result.claimed, refused: result.refused, unknown: result.unknown },
        };
      }

      return { status: 404, payload: { error: `no route for ${pathname}` } };
    },
  };
}

/**
 * The same ledger behind a real socket, for a suite that spawns the server as a
 * child process and so cannot be reached by stubbing `fetch` in this one.
 */
export async function startFakeIdeasServer(): Promise<{ url: string; stop: () => Promise<void> }> {
  const store = ledger();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown> = {};
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const { status, payload } = store.handle(new URL(req.url ?? '/', 'http://localhost').pathname, body);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Point `IDEAS_URL`/`IDEAS_TOKEN` at an in-memory ledger and route `fetch` to it.
 *
 * Call `restore()` in an `afterEach`; leaving it installed would let one suite's
 * ledger answer another's.
 */
export function installFakeIdeasWorker(): FakeIdeasWorker {
  const store = ledger();
  const realFetch = globalThis.fetch;
  const priorUrl = process.env.IDEAS_URL;
  const priorToken = process.env.IDEAS_TOKEN;
  process.env.IDEAS_URL = ORIGIN;
  process.env.IDEAS_TOKEN = 'test-token';

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(href);
    // Anything not addressed to the ledger goes to the real `fetch`, so a suite
    // stubbing this one does not also blind everything else in the process.
    if (url.origin !== ORIGIN) return realFetch(input, init);

    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const { status, payload } = store.handle(url.pathname, body);
    return json(payload, status);
  }) as typeof fetch;

  return {
    store: store.get,
    set: store.set,
    restore: () => {
      globalThis.fetch = realFetch;
      if (priorUrl === undefined) delete process.env.IDEAS_URL;
      else process.env.IDEAS_URL = priorUrl;
      if (priorToken === undefined) delete process.env.IDEAS_TOKEN;
      else process.env.IDEAS_TOKEN = priorToken;
    },
  };
}
