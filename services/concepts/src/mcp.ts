/**
 * MCP over streamable HTTP, hand-rolled rather than via the official SDK — see
 * ADR 0005. Implements revision 2026-07-28 and nothing earlier: every request
 * declares its own protocol version, there is no `initialize` handshake and no
 * session, and the answer is always a single `application/json` body.
 */

import type { Db } from './db.ts';
import { conceptFacets, getConceptById, getConceptsByTerm, listConcepts, searchConcepts } from './store.ts';

/**
 * The revisions this server speaks. Modern-era only: a legacy client that
 * expects a handshake is turned away rather than served, which is what keeps
 * the server stateless and the per-connection cost at zero.
 */
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28'];
const SERVER_INFO = { name: 'concepts', version: '0.1.0' };

/** `_meta` keys the revision reserves for per-request protocol metadata. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Error codes MCP allocates from the JSON-RPC range reserved for the spec. */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * What the server can do. `extensions` is a map of extension identifier to that
 * extension's settings object; this server advertises none, so it is empty
 * rather than absent.
 */
const CAPABILITIES = {
  tools: { listChanged: false },
  extensions: {} as Record<string, Record<string, unknown>>,
};

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RequestId = string | number | null | undefined;

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

function jsonBody(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function result(id: RequestId, value: unknown): Response {
  return jsonBody({ jsonrpc: '2.0', id: id ?? null, result: value }, 200);
}

function rpcError(id: RequestId, code: number, message: string, status: number): Response {
  return jsonBody({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status);
}

/**
 * The one error a client can always act on: it names every version this server
 * would have accepted, so a client that guessed wrong knows what to retry with.
 */
function unsupportedVersion(id: RequestId, requested: string | null, message: string): Response {
  const error = {
    code: UNSUPPORTED_PROTOCOL_VERSION,
    message,
    data: { supported: SUPPORTED_VERSIONS, requested },
  };
  return jsonBody({ jsonrpc: '2.0', id: id ?? null, error }, 400);
}

/** `=?base64?…?=` is how the binding carries a header value that is not plain ASCII. */
function decodeHeaderValue(value: string): string {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  try {
    const binary = atob(value.slice('=?base64?'.length, -'?='.length));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return value;
  }
}

function metaProtocolVersion(params: Record<string, unknown>): string | undefined {
  const meta = params._meta;
  if (typeof meta !== 'object' || meta === null) return undefined;
  const value = (meta as Record<string, unknown>)[META_PROTOCOL_VERSION];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The headers the transport mirrors from the body, so an intermediary can route
 * on them. They are required, and a value that disagrees with the body is
 * rejected rather than reconciled — the disagreement is the vulnerability.
 */
function mirroredHeaderMismatch(request: Request, method: string, params: Record<string, unknown>): string | null {
  const headerMethod = request.headers.get('mcp-method');
  if (!headerMethod) return 'missing required header Mcp-Method';
  if (headerMethod !== method) return `Mcp-Method header "${headerMethod}" does not match body method "${method}"`;

  // Mcp-Name mirrors `params.name` (or `params.uri`); only tools/call has one here.
  if (method === 'tools/call') {
    const headerName = request.headers.get('mcp-name');
    if (!headerName) return 'missing required header Mcp-Name';
    const bodyName = typeof params.name === 'string' ? params.name : '';
    const decoded = decodeHeaderValue(headerName);
    if (decoded !== bodyName) return `Mcp-Name header "${decoded}" does not match body name "${bodyName}"`;
  }

  return null;
}

export async function handleMcp(request: Request, db: Db): Promise<Response> {
  // No GET stream and no session to DELETE: this server never initiates a
  // message, so POST is the only verb the endpoint has.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || typeof body.method !== 'string') return rpcError(null, -32700, 'parse error', 400);
  const { id, method } = body;
  const params = body.params ?? {};

  // A legacy client has no fall-forward mechanism, so this error is the only
  // diagnostic it will ever see: name the versions it would need, rather than
  // answering the handshake with a bare "method not found".
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    return unsupportedVersion(
      id,
      requested,
      'this server implements MCP 2026-07-28, which has no initialize handshake',
    );
  }

  // The revision defines no client-to-server notifications over streamable
  // HTTP — closing the response stream is the only signal a client sends — so
  // there is nothing here to accept.
  if (method.startsWith('notifications/')) {
    return rpcError(null, -32600, `no client notification is defined by this protocol revision: ${method}`, 400);
  }

  // Version is declared per request, in a header and in `_meta`, and the two
  // must agree. Accept or reject this request alone; nothing is remembered.
  const headerVersion = request.headers.get('mcp-protocol-version');
  const bodyVersion = metaProtocolVersion(params);
  if (!headerVersion) return rpcError(id, HEADER_MISMATCH, 'missing required header MCP-Protocol-Version', 400);
  if (!bodyVersion) {
    return rpcError(id, HEADER_MISMATCH, `missing required params._meta["${META_PROTOCOL_VERSION}"]`, 400);
  }
  if (headerVersion !== bodyVersion) {
    const message = `MCP-Protocol-Version header "${headerVersion}" does not match body value "${bodyVersion}"`;
    return rpcError(id, HEADER_MISMATCH, message, 400);
  }
  if (!SUPPORTED_VERSIONS.includes(bodyVersion)) {
    return unsupportedVersion(id, bodyVersion, 'unsupported protocol version');
  }

  const mismatch = mirroredHeaderMismatch(request, method, params);
  if (mismatch) return rpcError(id, HEADER_MISMATCH, mismatch, 400);

  // Mandatory: how a client learns the versions, capabilities and identity of
  // this server without having to provoke an error first.
  if (method === 'server/discover') {
    return result(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: CAPABILITIES,
      instructions:
        'The glossary of terms the user has taught themselves. Call concepts_list first for a cheap overview of everything available, then concepts_get or concepts_search when you need the prose.',
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    });
  }

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
      // A tool failure is reported inside the result, not as a transport error,
      // so the model can see it and correct its arguments.
      return result(id, {
        content: [{ type: 'text', text: `tool ${name} failed: ${(error as Error).message}` }],
        isError: true,
      });
    }
  }

  // 404 with a JSON-RPC body, which is what tells a client this endpoint is a
  // modern MCP server rather than a host that does not serve MCP at all.
  return rpcError(id, -32601, `method not found: ${method}`, 404);
}
