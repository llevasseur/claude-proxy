/**
 * MCP over streamable HTTP, hand-rolled.
 *
 * The official SDK is not used, and that is a deliberate cost: this repo's
 * proxy package ships zero runtime dependencies and `@claude-proxy/core` ships
 * none either, so the one place a dependency would have to earn its way in is
 * here. What it would buy is transport plumbing — session ids, SSE resumption,
 * server-initiated messages — none of which this service does. What it costs is
 * a dependency inside the request path of the only always-on component in the
 * system. Three tools and five JSON-RPC methods is less code than the wiring
 * needed to configure the SDK, so it is written out.
 *
 * The response is always a single `application/json` body. The spec permits
 * that for a request the server can answer immediately, and every method here
 * can be.
 */

import type { Db } from './db.ts';
import { conceptFacets, getConceptById, getConceptsByTerm, listConcepts, searchConcepts } from './store.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'concepts', version: '0.1.0' };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Filter parameters shared by `concepts_list` and `concepts_search`. */
const FILTER_PROPERTIES = {
  field: { type: 'string', description: 'Only concepts in this field of study, e.g. "distributed systems".' },
  skill: { type: 'string', description: 'Only concepts tagged with this skill.' },
  since: { type: 'string', description: 'ISO-8601 timestamp; only concepts saved at or after it.' },
  hasNotes: { type: 'boolean', description: 'Only concepts that carry long-form notes.' },
  includeSuperseded: {
    type: 'boolean',
    description: 'Include older versions of a re-taught term. Default false, meaning newest per term.',
  },
  limit: { type: 'number', description: 'Maximum records to return. Default and ceiling 1000.' },
} as const;

const TOOLS = [
  {
    name: 'concepts_list',
    description:
      'List the concepts the user has taught themselves, newest first. Returns the whole glossary in compact form — term, one-sentence definition, field, skills, date — without the long-form notes, so it is cheap to call with no arguments to see everything available. Set facets:true to also get counts per field and per skill, which is how you discover what values the field and skill filters accept. Call this first when you want an overview; call concepts_get or concepts_search when you need the prose.',
    inputSchema: {
      type: 'object',
      properties: {
        ...FILTER_PROPERTIES,
        facets: { type: 'boolean', description: 'Also return field and skill counts.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'concepts_get',
    description:
      "Fetch one concept in full — definition, notes, tips, sources and skills. Look it up by `term` (case-insensitive, the normal way) or by the opaque `id` from a previous result. Because the store is append-only, a term that was taught more than once has several versions: the newest is returned as `concept` and the rest come back under `versions`, which is how you see how the user's understanding changed.",
    inputSchema: {
      type: 'object',
      properties: {
        term: { type: 'string', description: 'The term to look up, case-insensitive.' },
        id: { type: 'string', description: 'Exact record id from an earlier result.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'concepts_search',
    description:
      "Full-text search across every concept's term, definition, notes and tips, ranked by BM25 relevance and returned in full. Use this when you do not know the exact term — it matches the prose, not just the title. The same field/skill/since/hasNotes filters as concepts_list narrow the results. Query syntax is plain words; AND, OR and NOT in capitals work, everything else is matched literally.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to search for.' },
        ...FILTER_PROPERTIES,
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
] as const;

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value ? value : undefined;
}

function bool(args: Record<string, unknown>, key: string): boolean | undefined {
  return args[key] === true ? true : undefined;
}

function filterFromArgs(args: Record<string, unknown>) {
  return {
    field: str(args, 'field'),
    skill: str(args, 'skill'),
    since: str(args, 'since'),
    hasNotes: bool(args, 'hasNotes'),
    includeSuperseded: bool(args, 'includeSuperseded'),
    limit: typeof args.limit === 'number' ? args.limit : undefined,
  };
}

async function callTool(db: Db, name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name === 'concepts_list') {
    const filter = filterFromArgs(args);
    const concepts = await listConcepts(db, filter);
    const payload: Record<string, unknown> = { count: concepts.length, concepts };
    if (args.facets === true) payload.facets = await conceptFacets(db, filter);
    return payload;
  }

  if (name === 'concepts_get') {
    const id = str(args, 'id');
    if (id) {
      const concept = await getConceptById(db, id);
      return concept ? { concept } : { error: `no concept with id ${id}` };
    }
    const term = str(args, 'term');
    if (!term) return { error: 'pass either `term` or `id`' };
    const versions = await getConceptsByTerm(db, term);
    if (versions.length === 0) return { error: `no concept for term "${term}"` };
    return { concept: versions[0]!, versions: versions.slice(1) };
  }

  if (name === 'concepts_search') {
    const query = str(args, 'query');
    if (!query) return { error: '`query` is required' };
    const results = await searchConcepts(db, query, filterFromArgs(args));
    return { count: results.length, results };
  }

  return { error: `unknown tool ${name}` };
}

function result(id: string | number | null | undefined, value: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result: value }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function rpcError(id: string | number | null | undefined, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function handleMcp(request: Request, db: Db): Promise<Response> {
  // No GET stream: this server never initiates a message, so there is nothing
  // for a long-lived SSE channel to carry.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || typeof body.method !== 'string') return rpcError(null, -32700, 'parse error');
  const { id, method } = body;
  const params = body.params ?? {};

  if (method === 'initialize') {
    return result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
    });
  }

  // Notifications carry no id and get no body — only an acknowledgement.
  if (method.startsWith('notifications/')) return new Response(null, { status: 202 });

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') return result(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    try {
      const payload = await callTool(db, name, args);
      const isError = typeof payload === 'object' && payload !== null && 'error' in payload;
      return result(id, {
        content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
        isError,
      });
    } catch (error) {
      // A tool failure is reported inside the result, not as a transport
      // error: the model should see it and be able to correct its arguments.
      return result(id, {
        content: [{ type: 'text', text: `tool ${name} failed: ${(error as Error).message}` }],
        isError: true,
      });
    }
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}
