/**
 * The warm read-through: what the server makes of the proxy's `/__warm` document, and what
 * it does when there is no proxy to ask.
 *
 * The proxy is stubbed rather than started. What is under test is the narrowing and the
 * failure vocabulary on this side — the endpoint's own behaviour is already covered by
 * `stacks/claude/proxy/warm.test.ts`, and standing a second process up here would test that
 * again at the cost of a socket.
 */
import { describe, expect, it } from 'vitest';
import { resolveProxyBaseUrl } from '../src/config.js';
import type { JsonObject } from '../src/json.js';
import { buildWarmStatus, releaseWarmSession, type WarmFetch, WarmProxyError } from '../src/warm.js';

const BASE = 'http://127.0.0.1:8787';

/** A stub that records the call and answers with a canned document, as the endpoint would. */
function stub(status: number, body: JsonObject) {
  const calls: { url: string; method: string | undefined; body: string | undefined }[] = [];
  const fetchImpl: WarmFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

/** One row in the shape `warmStatusDocument()` builds. */
const ROW = {
  sessionKey: 'sess-1',
  account: 'acct-1',
  state: 'armed',
  pingsSent: 3,
  cacheReadTokens: 12_000,
  usageUnits: 0.5,
  ttlMs: 300_000,
  registeredAt: '2026-09-16T09:00:00.000Z',
  lastActivity: '2026-09-16T09:05:00.000Z',
  deadline: '2026-09-16T17:00:00.000Z',
  outcome: null,
};

describe('buildWarmStatus', () => {
  it('carries the proxy document through, entries and totals alike', async () => {
    const { calls, fetchImpl } = stub(200, {
      updatedAt: '2026-09-16T09:06:00.000Z',
      entries: [ROW],
      totals: {
        entries: 1,
        pending: 0,
        armed: 1,
        stopped: 0,
        resumed: 0,
        pingsSent: 3,
        cacheReadTokens: 12_000,
        usageUnits: 0.5,
      },
    });

    const status = await buildWarmStatus(BASE, fetchImpl);

    expect(calls).toEqual([{ url: `${BASE}/__warm`, method: 'GET', body: undefined }]);
    expect(status.updatedAt).toBe('2026-09-16T09:06:00.000Z');
    expect(status.entries).toHaveLength(1);
    expect(status.entries[0]).toMatchObject({ sessionKey: 'sess-1', state: 'armed', ttlMs: 300_000 });
    expect(status.totals.armed).toBe(1);
    // The reader names which proxy it read, so an unexpected answer is traceable to a port.
    expect(status.meta.proxy).toBe(BASE);
  });

  it('defaults a row the proxy no longer sends every field for', async () => {
    const { fetchImpl } = stub(200, { entries: [{ sessionKey: 'sess-2' }] });

    const status = await buildWarmStatus(BASE, fetchImpl);

    // A field that went missing costs its own cell, never the page.
    expect(status.entries[0]).toMatchObject({ sessionKey: 'sess-2', state: 'unknown', pingsSent: 0, outcome: null });
    expect(status.updatedAt).toBeNull();
  });

  it('counts the rows itself when the document carries no totals', async () => {
    const { fetchImpl } = stub(200, { entries: [ROW, { ...ROW, sessionKey: 'sess-3', state: 'pending' }] });

    const status = await buildWarmStatus(BASE, fetchImpl);

    expect(status.totals).toMatchObject({ entries: 2, armed: 1, pending: 1, stopped: 0 });
  });

  it('refuses rather than reporting nothing warm when the proxy is unreachable', async () => {
    const fetchImpl: WarmFetch = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8787');
    };

    await expect(buildWarmStatus(BASE, fetchImpl)).rejects.toBeInstanceOf(WarmProxyError);
    await expect(buildWarmStatus(BASE, fetchImpl)).rejects.toThrow(/unreachable at http:\/\/127\.0\.0\.1:8787/);
  });

  it('relays the refusal the endpoint wrote instead of restating it', async () => {
    const { fetchImpl } = stub(403, { error: 'the warm control endpoint is loopback-only' });

    await expect(buildWarmStatus(BASE, fetchImpl)).rejects.toThrow(/403: the warm control endpoint is loopback-only/);
  });
});

describe('releaseWarmSession', () => {
  it('issues a DELETE naming the session, and reports what the proxy did', async () => {
    const { calls, fetchImpl } = stub(200, { ok: true, sessionId: 'sess-1', released: true });

    const reply = await releaseWarmSession(BASE, 'sess-1', fetchImpl);

    expect(calls).toEqual([{ url: `${BASE}/__warm`, method: 'DELETE', body: JSON.stringify({ sessionId: 'sess-1' }) }]);
    expect(reply).toEqual({ sessionId: 'sess-1', released: true, meta: { proxy: BASE } });
  });

  it('reports a session the proxy was not holding as not released, not as a failure', async () => {
    const { fetchImpl } = stub(200, { ok: true, sessionId: 'gone', released: false });

    await expect(releaseWarmSession(BASE, 'gone', fetchImpl)).resolves.toMatchObject({ released: false });
  });
});

describe('resolveProxyBaseUrl', () => {
  it('defaults to the proxy on loopback at its own port', () => {
    expect(resolveProxyBaseUrl({})).toBe('http://127.0.0.1:8787');
  });

  it('takes CLAUDE_PROXY_PORT, and a whole CLAUDE_PROXY_URL over it', () => {
    expect(resolveProxyBaseUrl({ CLAUDE_PROXY_PORT: '9999' })).toBe('http://127.0.0.1:9999');
    expect(resolveProxyBaseUrl({ CLAUDE_PROXY_URL: 'http://proxy.local:1234/', CLAUDE_PROXY_PORT: '9999' })).toBe(
      'http://proxy.local:1234',
    );
  });

  it('ignores the bare PORT the proxy falls back to, which in this process is the server one', () => {
    // Honouring it would aim the server at itself and report the wrong process as down.
    expect(resolveProxyBaseUrl({ PORT: '8788' })).toBe('http://127.0.0.1:8787');
  });
});
