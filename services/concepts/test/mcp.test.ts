import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../src/auth.ts';
import type { Db } from '../src/db.ts';
import { handleMcp } from '../src/mcp.ts';
import { saveConcept } from '../src/store.ts';
import { concept, testDb } from './harness.ts';

function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1) {
  return new Request('https://concepts.example/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
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
  it('initializes with a protocol version and tool capability', async () => {
    const response = await handleMcp(rpc('initialize'), testDb());
    const body = (await response.json()) as { result: { protocolVersion: string; capabilities: unknown } };
    expect(body.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.result.capabilities).toHaveProperty('tools');
  });

  it('advertises exactly the three concept tools, each with a schema', async () => {
    const response = await handleMcp(rpc('tools/list'), testDb());
    const body = (await response.json()) as { result: { tools: { name: string; inputSchema: unknown }[] } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['concepts_list', 'concepts_get', 'concepts_search']);
    for (const tool of body.result.tools) expect(tool.inputSchema).toHaveProperty('properties');
  });

  it('acknowledges a notification without a body', async () => {
    const response = await handleMcp(rpc('notifications/initialized', {}, null), testDb());
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  it('answers ping', async () => {
    const response = await handleMcp(rpc('ping'), testDb());
    expect((await response.json()) as unknown).toMatchObject({ result: {} });
  });

  it('reports an unknown method as a JSON-RPC error', async () => {
    const response = await handleMcp(rpc('resources/list'), testDb());
    const body = (await response.json()) as { error: { code: number } };
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
