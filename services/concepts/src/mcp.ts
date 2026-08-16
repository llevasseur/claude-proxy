/**
 * MCP over streamable HTTP, hand-rolled rather than via the official SDK — see
 * ADR 0005. Implements revision 2026-07-28 and nothing earlier: every request
 * declares its own protocol version, there is no `initialize` handshake and no
 * session, and the answer is always a single `application/json` body.
 */

import {
  type IdeaFilter,
  type IdeaStatus,
  isIdeaStatus,
  parseIdeaAdds,
  parseIdeaClaims,
  parseIdeaMarks,
} from '@claude-proxy/core';
import type { Db } from './db.ts';
import { addIdeas, claimIdeas, getIdea, IdeaError, listIdeas, markIdeas } from './ideas.ts';
import { conceptFacets, getConceptById, getConceptsByTerm, listConcepts, searchConcepts } from './store.ts';

/**
 * The revisions this server speaks. Modern-era only: a legacy client that
 * expects a handshake is turned away rather than served.
 */
const SUPPORTED_VERSIONS: readonly string[] = ['2026-07-28'];
const SERVER_INFO = { name: 'operator', version: '0.2.0' };

/** `_meta` keys the revision reserves for per-request protocol metadata. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Error codes MCP allocates from the JSON-RPC range reserved for the spec. */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * `extensions` is a map of extension identifier to that extension's settings
 * object; this server advertises none, so it is empty rather than absent.
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
  {
    name: 'ideas_list',
    description:
      "List the ideas ledger — features and commands somebody proposed building, and what a human decided about each one. This is NOT the same thing as a session suggestion: an idea is invented and carries no source sessions, so only the `accepted` status (a recorded human sign-off) makes one actionable. Statuses are proposed, accepted, claimed, rejected and shipped, and rejected rows are kept deliberately, with their reasons, because they are what stops an idea being proposed twice. Set available:true to get exactly what an implementation run may take right now — `accepted` plus any `claimed` idea whose claim has expired; that is the query to use before building something, because plain status:accepted misses an idea abandoned by a run that died, and status:'accepted,claimed' would take one out from under a live holder.",
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Comma-separated: proposed, accepted, claimed, rejected, shipped.' },
        repo: { type: 'string', description: 'A git remote slug like owner/name. Never a checkout path.' },
        area: { type: 'string', description: 'One kebab-case area, matched exactly.' },
        available: { type: 'boolean', description: 'Only what may be claimed right now. Overrides status.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ideas_get',
    description:
      "Fetch ONE idea by its key. The key is the kebab-case slug, and it is the idea's only identifier — the same string the dashboard's permalink uses, the same one ideas_add dedupes against, and the same `slug` argument ideas_claim and ideas_mark already take. Use this whenever you hold a key and want that idea whole: its rationale, its evidence with locators, its area and repo, its status, the human's note or comment, and the claim currently held on it. Prefer it over calling ideas_list and filtering client-side, which reads the entire ledger to answer about one row. A key nothing was ever added under comes back as an error naming it — which is NOT the same as a rejected idea, since rejected rows are kept deliberately and answer here carrying the reason they were turned down.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "The idea's kebab-case key." },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'ideas_add',
    description:
      'Record one or more proposals on the ledger. Each entry is { slug, title, rationale, evidence[], repo, area }, where the slug is a kebab-case dedupe key and evidence cites at least one of open-question, judge-note, changelog, deferral or command-gap — each with a locator (a path, or bucket + id for a judge note) except command-gap, which describes a command nobody wrote and so has none, and is confined to the "commands" area. An entry citing nothing is refused rather than stored. A slug already on the ledger in ANY status, including rejected, is refused without being overwritten, and the rest of the batch still lands. The reply also reports near-duplicate existing slugs under `similar`, checked against the whole shared corpus rather than one machine\'s — look at those before insisting on your slug, because a near-duplicate under a different name defeats the dedupe key.',
    inputSchema: {
      type: 'object',
      properties: {
        ideas: { type: 'array', description: 'The entries to record.', items: { type: 'object' } },
      },
      required: ['ideas'],
      additionalProperties: false,
    },
  },
  {
    name: 'ideas_claim',
    description:
      'Take an idea for implementation. This is the FIRST thing an implementation run does, before it writes any code — not something it does when its PR opens, because that gap is what let two runs build the same accepted idea eleven minutes apart. `by` names the holder: a branch, a run id, a person, whatever a second run can recognise as not itself. Only an `accepted` idea may be claimed, or a `claimed` one whose claim has gone stale (six hours with no PR recorded; a claim carrying a pr never goes stale). A claim held by somebody else comes back under `refused` naming the holder — walk away and pick a different idea, do not retry. Re-claiming as the same `by` is idempotent, and is how a run attaches its `pr` later.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "The idea's kebab-case key." },
        by: { type: 'string', description: 'The holder to record.' },
        pr: { type: 'string', description: 'The PR url, once one exists. Pins the claim open indefinitely.' },
      },
      required: ['slug', 'by'],
      additionalProperties: false,
    },
  },
  {
    name: 'ideas_mark',
    description:
      "Change an idea's status. `rejected` requires a note giving the reason — it is the ledger's record of why, and what stops the idea being re-proposed — and `shipped` requires the PR url as its note, since shipped is a claim about something that landed. `proposed` is the undo, restoring an idea to unsigned-off without erasing it or its note. Marking anything other than `shipped` RELEASES any claim, which is how a run that gives up hands an idea back before the six-hour expiry; `shipped` keeps the claim as the record of who built the thing. A mark on a slug the ledger does not carry writes nothing and comes back under `unknown`.",
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: "The idea's kebab-case key." },
        status: { type: 'string', description: 'proposed, accepted, claimed, rejected or shipped.' },
        note: { type: 'string', description: 'The reason for rejected; the PR url for shipped.' },
      },
      required: ['slug', 'status'],
      additionalProperties: false,
    },
  },
] as const;

/** Reads the ledger filter arguments the way the REST route reads its query string. */
function ideaFilterFromArgs(args: Record<string, unknown>): IdeaFilter {
  const filter: IdeaFilter = {};
  const status = str(args, 'status');
  if (status) {
    const statuses = status.split(',').map((part) => part.trim());
    const bad = statuses.find((value) => !isIdeaStatus(value));
    if (bad !== undefined) throw new Error(`invalid status: ${bad}`);
    filter.statuses = statuses as IdeaStatus[];
  }
  const repo = str(args, 'repo');
  if (repo) filter.repo = repo;
  const area = str(args, 'area');
  if (area) filter.area = area;
  return filter;
}

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

  if (name === 'ideas_list') {
    return await listIdeas(db, ideaFilterFromArgs(args), args.available === true);
  }

  if (name === 'ideas_get') {
    const slug = str(args, 'slug');
    if (!slug) return { error: '`slug` is required' };
    try {
      const idea = await getIdea(db, slug);
      // Absence is reported as a tool error rather than `{ idea: null }`, so a
      // model cannot read a successful call as the idea existing and unclaimed.
      return idea ? { idea } : { error: `no idea on the ledger is called ${slug}` };
    } catch (error) {
      // A malformed key is the model's mistake to correct, so it comes back in
      // the same `{ error }` shape every other tool refuses with, rather than as
      // the bare `tool … failed:` string an escaped throw would produce.
      if (error instanceof IdeaError) return { error: error.message };
      throw error;
    }
  }

  if (name === 'ideas_add') {
    // Parsed by the same function the CLI and the dashboard use, so the evidence
    // and area rules refuse identically wherever an idea is proposed from.
    return await addIdeas(db, parseIdeaAdds(args.ideas));
  }

  if (name === 'ideas_claim') {
    const [claim] = parseIdeaClaims([
      { slug: args.slug, by: args.by, ...(args.pr === undefined ? {} : { pr: args.pr }) },
    ]);
    const result = await claimIdeas(db, [claim!]);
    // A refusal is reported as a tool error so the model cannot read a plain
    // result as permission to start building what somebody else already is.
    return result.claimed.length > 0 ? result : { error: refusalMessage(result), ...result };
  }

  if (name === 'ideas_mark') {
    const [mark] = parseIdeaMarks([
      { slug: args.slug, status: args.status, ...(args.note === undefined ? {} : { note: args.note }) },
    ]);
    if ((mark!.status === 'rejected' || mark!.status === 'shipped') && !mark!.note?.trim()) {
      return {
        error:
          mark!.status === 'rejected'
            ? 'rejecting an idea needs the reason as `note` — it is the row a later run most needs'
            : 'shipping an idea needs the PR url as `note` — `shipped` is a claim about something that landed',
      };
    }
    const result = await markIdeas(db, [mark!]);
    return result.unknown.length > 0
      ? { error: `no idea on the ledger is called ${result.unknown.join(', ')}` }
      : result;
  }

  return { error: `unknown tool ${name}` };
}

/** Says who holds the idea, or which status refused it, in one line a model can act on. */
function refusalMessage(result: {
  refused: { slug: string; status: string; heldBy?: string; since?: string }[];
  unknown: string[];
}): string {
  if (result.unknown.length > 0) return `no idea on the ledger is called ${result.unknown.join(', ')}`;
  const [refusal] = result.refused;
  if (!refusal) return 'nothing was claimed';
  return refusal.heldBy
    ? `${refusal.slug} is already held by ${refusal.heldBy} since ${refusal.since} — pick a different idea`
    : `${refusal.slug} is ${refusal.status}, and only an accepted idea may be claimed`;
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

/** Names every version this server would have accepted, so a client can retry. */
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
 * The headers the transport mirrors from the body. Required, and a value that
 * disagrees with the body is rejected rather than reconciled.
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
  // No GET stream and no session to DELETE: this server never initiates a message.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = (await request.json().catch(() => null)) as JsonRpcRequest | null;
  if (!body || typeof body.method !== 'string') return rpcError(null, -32700, 'parse error', 400);
  const { id, method } = body;
  const params = body.params ?? {};

  // A legacy client has no fall-forward mechanism, so name the versions it
  // would need rather than answering with a bare "method not found".
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : null;
    return unsupportedVersion(
      id,
      requested,
      'this server implements MCP 2026-07-28, which has no initialize handshake',
    );
  }

  // The revision defines no client-to-server notifications over streamable HTTP.
  if (method.startsWith('notifications/')) {
    return rpcError(null, -32600, `no client notification is defined by this protocol revision: ${method}`, 400);
  }

  // Declared per request in a header and in `_meta`, which must agree. Nothing
  // is remembered between requests.
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

  // Mandatory: how a client learns this server's versions, capabilities and identity.
  if (method === 'server/discover') {
    return result(id, {
      resultType: 'complete',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: CAPABILITIES,
      instructions:
        "Two datasets over one database. CONCEPTS is the glossary of terms the user has taught themselves — call concepts_list first for a cheap overview of everything available, then concepts_get or concepts_search when you need the prose. IDEAS is the ledger of proposals and what a human decided about each: call ideas_list with available:true to see what may be built right now, ideas_get to pull one idea whole when you already hold its key (the kebab-case slug is the idea's only identifier, and every ideas_* tool takes it), ideas_claim before you write any code, ideas_add to propose something (it dedupes against every machine, rejected rows included), and ideas_mark to record the outcome.",
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

  // 404 with a JSON-RPC body, which distinguishes a modern MCP endpoint from a
  // host that serves no MCP at all.
  return rpcError(id, -32601, `method not found: ${method}`, 404);
}
