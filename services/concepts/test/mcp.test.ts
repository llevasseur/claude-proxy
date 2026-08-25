import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/auth.ts';
import type { Db } from '../src/db.ts';
import { addIdeas, markIdeas } from '../src/ideas.ts';
import { type JsonRecord, textField } from '../src/json.ts';
import { handleMcp } from '../src/mcp.ts';
import { saveConcept } from '../src/store.ts';
import { arrayAt, bodyRecord, concept, numberAt, recordAt, recordsAt, testDb, textAt, textRecord } from './harness.ts';

const PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const META_VERSION = 'io.modelcontextprotocol/protocolVersion';

/** A raw POST, for the cases that are about a header being wrong or absent. */
function post(headers: Record<string, string>, body: JsonRecord) {
  return new Request('https://concepts.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A well-formed modern request: version in `_meta`, mirrored into
 * `MCP-Protocol-Version`, plus the other headers the binding requires.
 */
function rpc(method: string, params: JsonRecord = {}, version = PROTOCOL_VERSION) {
  const base = { 'mcp-protocol-version': version, 'mcp-method': method };
  // `Mcp-Name` mirrors the tool name and exists only when there is one to mirror,
  // which is exactly what one test removes to check the binding notices.
  const name = textField(params, 'name');
  const headers = name === undefined ? base : { ...base, 'mcp-name': name };
  return post(headers, {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: { ...params, _meta: { [META_VERSION]: version } },
  });
}

function legacyRpc(method: string, params: JsonRecord = {}, id: number | null = 1) {
  return post({ 'mcp-protocol-version': LEGACY_PROTOCOL_VERSION }, { jsonrpc: '2.0', id, method, params });
}

/**
 * One `tools/call` round trip, decoded once for every tool case below: the tool
 * result is a JSON document carried as text inside the content block, and every
 * assertion in this file reads a field out of that document.
 */
async function call(db: Db, name: string, args: JsonRecord = {}) {
  const response = await handleMcp(rpc('tools/call', { name, arguments: args }), db);
  const result = recordAt(await bodyRecord(response), 'result');
  const [block] = recordsAt(result, 'content');
  if (block === undefined) throw new Error(`tools/call ${name} answered with no content block`);
  const payload = textRecord(textAt(block, 'text'));
  expect(recordAt(result, 'structuredContent')).toEqual(payload);
  return {
    isError: result.isError === true,
    payload,
  };
}

describe('handleMcp', () => {
  it('discovers the exact supported version, the capabilities and the identity', async () => {
    const response = await handleMcp(rpc('server/discover'), testDb());
    const result = recordAt(await bodyRecord(response), 'result');
    const capabilities = recordAt(result, 'capabilities');
    expect(response.status).toBe(200);
    expect(arrayAt(result, 'supportedVersions')).toEqual([PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION]);
    expect(capabilities.tools).toBeDefined();
    expect(recordAt(capabilities, 'extensions')).toEqual({});
    // `operator`, not `concepts`: the Worker serves three datasets, while the
    // package directory retains the first dataset's historical name.
    expect(recordAt(result, '_meta')['io.modelcontextprotocol/serverInfo']).toEqual({
      name: 'operator',
      version: '0.2.0',
    });
  });

  it('advertises the concept, ideas, and notes tools, with input and note output schemas', async () => {
    const response = await handleMcp(rpc('tools/list'), testDb());
    const tools = recordsAt(recordAt(await bodyRecord(response), 'result'), 'tools');
    expect(tools.map((t) => textAt(t, 'name'))).toEqual([
      'concepts_list',
      'concepts_get',
      'concepts_search',
      'ideas_list',
      'ideas_get',
      'ideas_add',
      'ideas_claim',
      'ideas_mark',
      'notes_list',
      'notes_search',
      'notes_get',
      'notes_create',
      'notes_update',
      'notes_archive',
      'notes_restore',
    ]);
    for (const tool of tools) expect(tool.inputSchema).toHaveProperty('properties');
    for (const tool of tools.filter((tool) => textAt(tool, 'name').startsWith('notes_'))) {
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('rejects a version it does not implement, naming the ones it does', async () => {
    const response = await handleMcp(rpc('tools/list', {}, '2024-11-05'), testDb());
    const error = recordAt(await bodyRecord(response), 'error');
    expect(response.status).toBe(400);
    expect(numberAt(error, 'code')).toBe(-32022);
    expect(recordAt(error, 'data')).toEqual({
      supported: [PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION],
      requested: '2024-11-05',
    });
  });

  it('initializes the stateless protocol used by current Codex clients', async () => {
    const request = post(
      {},
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY_PROTOCOL_VERSION } },
    );
    const response = await handleMcp(request, testDb());
    const initialized = recordAt(await bodyRecord(response), 'result');
    expect(response.status).toBe(200);
    expect(textAt(initialized, 'protocolVersion')).toBe(LEGACY_PROTOCOL_VERSION);
    expect(recordAt(initialized, 'capabilities').tools).toBeDefined();
    expect(recordAt(initialized, 'serverInfo')).toEqual({ name: 'operator', version: '0.2.0' });
    expect(textAt(initialized, 'instructions')).toContain('Three datasets');
  });

  it('serves legacy tool discovery and calls without modern mirrored metadata', async () => {
    const listed = recordAt(await bodyRecord(await handleMcp(legacyRpc('tools/list'), testDb())), 'result');
    expect(recordsAt(listed, 'tools').map((tool) => textAt(tool, 'name'))).toContain('concepts_list');

    const called = await handleMcp(legacyRpc('tools/call', { name: 'concepts_list', arguments: {} }), testDb());
    const callResult = recordAt(await bodyRecord(called), 'result');
    expect(recordsAt(callResult, 'content')[0]).toMatchObject({ type: 'text' });
    expect(recordAt(callResult, 'structuredContent')).toMatchObject({ count: 0, concepts: [] });
  });

  it('rejects a request that declares no protocol version at all', async () => {
    const request = post({ 'mcp-method': 'tools/list' }, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const response = await handleMcp(request, testDb());
    expect(response.status).toBe(400);
    expect(numberAt(recordAt(await bodyRecord(response), 'error'), 'code')).toBe(-32020);
  });

  it('rejects a version header that disagrees with the one in _meta', async () => {
    const request = post(
      { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/list' },
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { [META_VERSION]: '2025-06-18' } } },
    );
    const body = await bodyRecord(await handleMcp(request, testDb()));
    expect(numberAt(recordAt(body, 'error'), 'code')).toBe(-32020);
  });

  it('rejects a request missing the mirrored Mcp-Method and Mcp-Name headers', async () => {
    const params = { name: 'concepts_list', arguments: {}, _meta: { [META_VERSION]: PROTOCOL_VERSION } };
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params };

    const noMethod = post({ 'mcp-protocol-version': PROTOCOL_VERSION }, message);
    expect((await handleMcp(noMethod, testDb())).status).toBe(400);

    const headers = { 'mcp-protocol-version': PROTOCOL_VERSION, 'mcp-method': 'tools/call' };
    const response = await handleMcp(post(headers, message), testDb());
    const error = recordAt(await bodyRecord(response), 'error');
    expect(response.status).toBe(400);
    expect(numberAt(error, 'code')).toBe(-32020);
    expect(textAt(error, 'message')).toContain('Mcp-Name');
  });

  it('acknowledges the legacy initialized notification without creating a session', async () => {
    const response = await handleMcp(legacyRpc('notifications/initialized', {}, null), testDb());
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('rejects a notification under the modern revision', async () => {
    const response = await handleMcp(rpc('notifications/initialized'), testDb());
    expect(response.status).toBe(400);
    expect(numberAt(recordAt(await bodyRecord(response), 'error'), 'code')).toBe(-32600);
  });

  it('answers ping', async () => {
    const response = await handleMcp(rpc('ping'), testDb());
    expect(await bodyRecord(response)).toMatchObject({ result: {} });
  });

  it('reports an unknown method as a 404 carrying a JSON-RPC error', async () => {
    const response = await handleMcp(rpc('resources/list'), testDb());
    expect(response.status).toBe(404);
    expect(numberAt(recordAt(await bodyRecord(response), 'error'), 'code')).toBe(-32601);
  });

  it('refuses GET, since the server never initiates a message', async () => {
    const response = await handleMcp(new Request('https://concepts.example/mcp'), testDb());
    expect(response.status).toBe(405);
  });

  it('rejects a body that is not JSON-RPC', async () => {
    const request = new Request('https://concepts.example/mcp', { method: 'POST', body: 'not json' });
    const body = await bodyRecord(await handleMcp(request, testDb()));
    expect(numberAt(recordAt(body, 'error'), 'code')).toBe(-32700);
  });
});

describe('concepts_list', () => {
  it('returns the compact glossary with no arguments', async () => {
    const db = testDb();
    await saveConcept(db, concept({ term: 'Quorum', notes: 'long prose that should not be in the listing' }));
    const { payload } = await call(db, 'concepts_list');
    expect(payload.count).toBe(1);
    const [first] = recordsAt(payload, 'concepts');
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
    expect(recordsAt(payload, 'concepts').map((c) => textAt(c, 'term'))).toEqual(['B']);
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
    expect(textAt(recordAt(payload, 'concept'), 'sentence')).toBe('v2');
    expect(recordsAt(payload, 'versions').map((v) => textAt(v, 'sentence'))).toEqual(['v1']);
  });

  it('flags a miss as an error the model can act on', async () => {
    const { payload, isError } = await call(testDb(), 'concepts_get', { term: 'nothing' });
    expect(isError).toBe(true);
    expect(textAt(payload, 'error')).toMatch(/no concept for term/);
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
    expect(recordsAt(payload, 'results').map((r) => textAt(r, 'term'))).toEqual(['Quorum']);
  });

  it('requires a query', async () => {
    const { isError } = await call(testDb(), 'concepts_search', {});
    expect(isError).toBe(true);
  });

  it('reports an unknown tool rather than throwing', async () => {
    const { isError, payload } = await call(testDb(), 'concepts_delete_everything');
    expect(isError).toBe(true);
    expect(textAt(payload, 'error')).toMatch(/unknown tool/);
  });
});

describe('notes tools', () => {
  it('creates, lists compactly, and gets full Markdown', async () => {
    const db = testDb();
    const created = await call(db, 'notes_create', { title: '', body: '# Heading\n\nFull **Markdown** body.' });
    const note = recordAt(created.payload, 'note');
    expect(note).toMatchObject({ title: '', body: '# Heading\n\nFull **Markdown** body.', version: 1 });

    const listed = await call(db, 'notes_list');
    const [summary] = recordsAt(listed.payload, 'notes');
    expect(summary).toMatchObject({ id: textAt(note, 'id'), title: '', excerpt: 'Heading Full Markdown body.' });
    expect(summary).not.toHaveProperty('body');

    const got = await call(db, 'notes_get', { id: textAt(note, 'id') });
    expect(recordAt(got.payload, 'note')).toMatchObject({ body: textAt(note, 'body') });
  });

  it('returns a structured tool error for a stale expected version', async () => {
    const db = testDb();
    const created = await call(db, 'notes_create', { title: 'Race', body: 'base' });
    const id = textAt(recordAt(created.payload, 'note'), 'id');
    await call(db, 'notes_update', { id, expectedVersion: 1, body: 'winner' });
    const stale = await call(db, 'notes_update', { id, expectedVersion: 1, body: 'loser' });
    expect(stale.isError).toBe(true);
    expect(stale.payload).toMatchObject({
      error: 'stale note version',
      conflict: true,
      code: 'stale_version',
      currentVersion: 2,
    });
    expect(stale.payload.attemptedRevisionId).toEqual(expect.any(String));
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
    const idea = recordAt(payload, 'idea');
    expect(textAt(idea, 'slug')).toBe('rolling-window');
    expect(textAt(idea, 'title')).toMatch(/rolling last-10 window/);
    expect(textAt(idea, 'status')).toBe('proposed');
    expect(arrayAt(idea, 'evidence')).toHaveLength(1);
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
    expect(textAt(payload, 'error')).toMatch(/no idea on the ledger is called never-proposed/);
  });

  it('refuses a malformed key rather than reporting it merely absent', async () => {
    const { payload, isError } = await call(testDb(), 'ideas_get', { slug: 'Not A Slug' });
    expect(isError).toBe(true);
    expect(textAt(payload, 'error')).toMatch(/invalid slug/);
  });

  it('requires a slug', async () => {
    const { isError, payload } = await call(testDb(), 'ideas_get', {});
    expect(isError).toBe(true);
    expect(textAt(payload, 'error')).toMatch(/`slug` is required/);
  });
});

describe('tool dispatch', () => {
  it('reports an unknown tool rather than throwing', async () => {
    const { isError, payload } = await call(testDb(), 'concepts_delete_everything');
    expect(isError).toBe(true);
    expect(textAt(payload, 'error')).toMatch(/unknown tool/);
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
