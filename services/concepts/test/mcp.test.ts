import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/auth.ts';
import type { Db } from '../src/db.ts';
import { addIdeas, markIdeas } from '../src/ideas.ts';
import { handleMcp } from '../src/mcp.ts';
import { saveConcept } from '../src/store.ts';
import { concept, testDb } from './harness.ts';

/** The one revision this server implements. Asserted exactly, never by shape. */
const PROTOCOL_VERSION = '2026-07-28';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** A raw POST, for the cases that are about a header being wrong or absent. */
function post(headers: Record<string, string>, body: unknown) {
  return new Request('https://concepts.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/**
 * A well-formed modern request: version in `_meta`, mirrored into
 * `MCP-Protocol-Version`, plus the other headers the binding requires.
 */
function rpc(method: string, params: Record<string, unknown> = {}, version = PROTOCOL_VERSION) {
  const headers: Record<string, string> = { 'mcp-protocol-version': version, 'mcp-method': method };
  if (typeof params.name === 'string') headers['mcp-name'] = params.name;
  return post(headers, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: { [META_VERSION]: version } },
  });
}

async function call(db: Db, name: string, args: Record<string, unknown> = {}) {
  const response = await handleMcp(rpc('tools/call', { name, arguments: args }), db);
  const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return {
    isError: body.result.isError === true,
    payload: JSON.parse(body.result.content[0]!.text) as Record<string, unknown>,
  };
}

describe('handleMcp', () => {
  it('discovers the exact supported version, the capabilities and the identity', async () => {
    const response = await handleMcp(rpc('server/discover'), testDb());
    const body = (await response.json()) as {
      result: {
        supportedVersions: string[];
        capabilities: { tools: unknown; extensions: Record<string, unknown> };
        _meta: Record<string, unknown>;
      };
    };
    expect(response.status).toBe(200);
    expect(body.result.supportedVersions).toEqual([PROTOCOL_VERSION]);
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.extensions).toEqual({});
    // `operator`, not `concepts`: the Worker serves two datasets, and the
    // package directory is the only narrow thing about it. See ADR 0006.
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']).toEqual({ name: 'operator', version: '0.2.0' });
  });

  it('advertises the three concept tools and the five ideas tools, each with a schema', async () => {
    const response = await handleMcp(rpc('tools/list'), testDb());
    const body = (await response.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual([
      'concepts_list',
      'concepts_get',
      'concepts_search',
      'ideas_list',
      'ideas_get',
      'ideas_add',
      'ideas_claim',
      'ideas_mark',
    ]);
    for (const tool of body.result.tools) expect(tool.inputSchema).toHaveProperty('properties');
  });

  it('rejects a version it does not implement, naming the ones it does', async () => {
    const response = await handleMcp(rpc('tools/list', {}, '2025-06-18'), testDb());
    const body = (await response.json()) as {
      error: { code: number; data: { supported: string[]; requested: string } };
    };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data).toEqual({ supported: [PROTOCOL_VERSION], requested: '2025-06-18' });
  });

  it('refuses initialize by naming its versions, since a legacy client cannot fall forward', async () => {
    const request = post(
      {},
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    );
    const response = await handleMcp(request, testDb());
    const body = (await response.json()) as { error: { code: number; message: string; data: { supported: string[] } } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toEqual([PROTOCOL_VERSION]);
    expect(body.error.message).toContain(PROTOCOL_VERSION);
  });

  it('rejects a request that declares no protocol version at all', async () => {
    const request = post({ 'mcp-method': 'tools/list' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const response = await handleMcp(request, testDb());
    const body = (await response.json()) as { error: { code: number } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32020);
  });

  it('rejects a version header that disagrees with the one in _meta', async () => {
    const request = post(
      { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_VERSION]: '2025-06-18' } } },
    );
    const body = (await (await handleMcp(request, testDb())).json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32020);
  });

  it('rejects a request missing the mirrored Mcp-Method and Mcp-Name headers', async () => {
    const params = { name: 'concepts_list', arguments: {}, _meta: { [META_VERSION]: PROTOCOL_VERSION } };
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params };

    const noMethod = post({ 'mcp-protocol-version': PROTOCOL_VERSION }, message);
    expect((await handleMcp(noMethod, testDb())).status).toBe(400);

    const headers = { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/call' };
    const response = await handleMcp(post(headers, message), testDb());
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain('Mcp-Name');
  });

  it('rejects a notification, since this revision defines none from the client', async () => {
    const response = await handleMcp(rpc('notifications/initialized'), testDb());
    const body = (await response.json()) as { error: { code: number } };
    expect(response.status).toBe(400);
    expect(body.error.code).toBe(-32600);
  });

  it('answers ping', async () => {
    const response = await handleMcp(rpc('ping'), testDb());
    expect((await response.json()) as unknown).toMatchObject({ result: {} });
  });

  it('reports an unknown method as a 404 carrying a JSON-RPC error', async () => {
    const response = await handleMcp(rpc('resources/list'), testDb());
    const body = (await response.json()) as { error: { code: number } };
    expect(response.status).toBe(404);
    expect(body.error.code).toBe(-32601);
  });

  it('refuses GET, since the server never initiates a message', async () => {
    const response = await handleMcp(new Request('https://concepts.example/mcp'), testDb());
    expect(response.status).toBe(405);
  });

  it('rejects a body that is not JSON-RPC', async () => {
    const request = new Request('https://concepts.example/mcp', { method: 'POST', body: 'not json' });
    const body = (await (await handleMcp(request, testDb())).json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('concepts_list', () => {
  it('returns the compact glossary with no arguments', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Quorum', notes: 'long prose that should not be in the listing' }));
    const { payload } = await call(db, 'concepts_list');
    expect(payload.count).toBe(1);
    const [first] = payload.concepts as Record<string, unknown>[];
    expect(first).toMatchObject({ term: 'Quorum', hasNotes: true });
    expect(first).not.toHaveProperty('notes');
  });

  it('returns facets on request, which is how filter values are discovered', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'A', field: 'systems' }));
    const { payload } = await call(db, 'concepts_list', { facets: true });
    expect(payload.facets).toMatchObject({ fields: [{ value: 'systems', count: 1 }] });
  });

  it('applies filters passed as tool arguments', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'A', field: 'systems' }));
    await saveConcept(db, concept({ term: 'B', field: 'frontend', savedAt: '2026-02-01T00:00:00.000Z' }));
    const { payload } = await call(db, 'concepts_list', { field: 'frontend' });
    expect((payload.concepts as { term: string }[]).map((c) => c.term)).toEqual(['B']);
  });
});

describe('concepts_get', () => {
  it('returns the full record including prose, looked up by term', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Quorum', notes: 'A majority must acknowledge.' }));
    const { payload, isError } = await call(db, 'concepts_get', { term: 'quorum' });
    expect(isError).toBe(false);
    expect(payload.concept).toMatchObject({ term: 'Quorum', notes: 'A majority must acknowledge.' });
  });

  it('separates the current version from the earlier ones', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Cache', sentence: 'v1', savedAt: '2026-01-01T00:00:00.000Z' }));
    await saveConcept(db, concept({ term: 'Cache', sentence: 'v2', savedAt: '2026-02-01T00:00:00.000Z' }));
    const { payload } = await call(db, 'concepts_get', { term: 'Cache' });
    expect((payload.concept as { sentence: string }).sentence).toBe('v2');
    expect((payload.versions as { sentence: string }[]).map((v) => v.sentence)).toEqual(['v1']);
  });

  it('flags a miss as an error the model can act on', async () => {
    const { payload, isError } = await call(testDb(), 'concepts_get', { term: 'nothing' });
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/no concept for term/);
  });

  it('requires one of term or id', async () => {
    const { isError } = await call(testDb(), 'concepts_get', {});
    expect(isError).toBe(true);
  });
});

describe('concepts_search', () => {
  it('finds a concept by words in its notes', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Quorum', notes: 'A majority of replicas acknowledge a write.' }));
    const { payload } = await call(db, 'concepts_search', { query: 'replicas' });
    expect((payload.results as { term: string }[]).map((r) => r.term)).toEqual(['Quorum']);
  });

  it('requires a query', async () => {
    const { isError } = await call(testDb(), 'concepts_search', {});
    expect(isError).toBe(true);
  });

  it('reports an unknown tool rather than throwing', async () => {
    const { isError, payload } = await call(testDb(), 'concepts_delete_everything');
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/unknown tool/);
  });
});

describe('ideas_get', () => {
  const seed = async (db: Db) => {
    await addIdeas(db, [
      {
        slug: 'rolling-window',
        title: 'A rolling last-10 window beside the fixed buckets',
        rationale: 'The fixed windows split a habit that spans a boundary.',
        evidence: [{ source: 'open-question' as const, path: 'docs/features/session-suggestions.md' }],
        repo: 'llevasseur/claude-proxy',
        area: 'ui-ux',
      },
    ]);
    return db;
  };

  it('returns one idea whole, addressed by its key alone', async () => {
    const { payload } = await call(await seed(testDb()), 'ideas_get', { slug: 'rolling-window' });
    const idea = payload.idea as { slug: string; title: string; status: string; evidence: unknown[] };
    expect(idea.slug).toBe('rolling-window');
    expect(idea.title).toMatch(/rolling last-10 window/);
    expect(idea.status).toBe('proposed');
    expect(idea.evidence).toHaveLength(1);
  });

  it('carries the decision a human recorded, so the key answers with its status', async () => {
    const db = await seed(testDb());
    await markIdeas(db, [{ slug: 'rolling-window', status: 'rejected', note: 'covered by /trends' }]);
    const { payload } = await call(db, 'ideas_get', { slug: 'rolling-window' });
    expect(payload.idea).toMatchObject({ status: 'rejected', note: 'covered by /trends' });
  });

  it('flags a key nothing was added under as an error the model can act on', async () => {
    const { payload, isError } = await call(await seed(testDb()), 'ideas_get', { slug: 'never-proposed' });
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/no idea on the ledger is called never-proposed/);
  });

  it('refuses a malformed key rather than reporting it merely absent', async () => {
    const { payload, isError } = await call(testDb(), 'ideas_get', { slug: 'Not A Slug' });
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/invalid slug/);
  });

  it('requires a slug', async () => {
    const { isError, payload } = await call(testDb(), 'ideas_get', {});
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/`slug` is required/);
  });
});

describe('tool dispatch', () => {
  it('reports an unknown tool rather than throwing', async () => {
    const { isError, payload } = await call(testDb(), 'concepts_delete_everything');
    expect(isError).toBe(true);
    expect(payload.error).toMatch(/unknown tool/);
  });
});

describe('isAuthorized', () => {
  const withHeader = (value?: string) =>
    new Request('https://concepts.example/mcp', { headers: value ? { authorization: value } : {} });

  it('accepts the exact bearer token', () => {
    expect(isAuthorized(withHeader('Bearer s3cret'), 's3cret')).toBe(true);
    expect(isAuthorized(withHeader('bearer s3cret'), 's3cret')).toBe(true);
  });

  it('rejects a wrong, absent or malformed token', () => {
    expect(isAuthorized(withHeader('Bearer wrong'), 's3cret')).toBe(false);
    expect(isAuthorized(withHeader(), 's3cret')).toBe(false);
    expect(isAuthorized(withHeader('s3cret'), 's3cret')).toBe(false);
  });

  it('denies everything when the secret is unset, rather than defaulting open', () => {
    expect(isAuthorized(withHeader('Bearer anything'), undefined)).toBe(false);
    expect(isAuthorized(withHeader('Bearer '), '')).toBe(false);
  });
});
