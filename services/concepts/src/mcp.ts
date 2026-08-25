/**
 * MCP over streamable HTTP, hand-rolled rather than via the official SDK — see
 * ADR 0005. Implements the stateless 2025-06-18 handshake used by current
 * clients and the 2026-07-28 per-request protocol. Both paths always answer
 * with a single `application/json` body and neither creates a session.
 */

import {
  type IdeaEntry,
  type IdeaFilter,
  type IdeaStatus,
  isIdeaStatus,
  parseIdeaAdds,
  parseIdeaClaims,
  parseIdeaMarks,
} from '@agent-proxy/claude-core';
import type { Db } from './db.ts';
import {
  addIdeas,
  claimIdeas,
  getIdea,
  type IdeaAddOutcome,
  type IdeaClaimOutcome,
  IdeaError,
  type IdeasListResult,
  type IdeaWriteOutcome,
  listIdeas,
  markIdeas,
} from './ideas.ts';
import {
  flagField,
  isJsonNumber,
  isJsonText,
  type JsonRecord,
  numberField,
  readJsonRecord,
  recordField,
  textField,
} from './json.ts';
import {
  archiveNote,
  createNote,
  getNote,
  listNotes,
  type Note,
  type NoteConflict,
  type NotePage,
  restoreNote,
  searchNotes,
  updateNote,
} from './notes.ts';
import {
  type ConceptSummary,
  conceptFacets,
  type Facets,
  getConceptById,
  getConceptsByTerm,
  type HostedConcept,
  listConcepts,
  type SearchHit,
  searchConcepts,
} from './store.ts';

/** Supported revisions, newest first. Neither requires server-side session state. */
const MODERN_PROTOCOL_VERSION = '2026-07-28';
const LEGACY_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSION];
const SERVER_INFO = { name: 'operator', version: '0.2.0' };
const SERVER_INSTRUCTIONS =
  'Three datasets over one database. CONCEPTS is the glossary of terms the user has taught themselves — call concepts_list first for a cheap overview, then concepts_get or concepts_search for prose. IDEAS is the proposal ledger: call ideas_list with available:true, ideas_get for one key, ideas_claim before coding, ideas_add to propose, and ideas_mark to record the outcome. NOTES is authored Markdown: call notes_list or notes_search for compact results, notes_get for the full body, and always pass the last observed version to notes_update.';

/** `_meta` keys the revision reserves for per-request protocol metadata. */
const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Error codes MCP allocates from the JSON-RPC range reserved for the spec. */
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/**
 * What `server/discover` advertises. `extensions` is a map of extension
 * identifier to that extension's settings object, and each of those is an
 * arbitrary JSON object the extension owns rather than a shape this server can
 * name — which is why the value type is the parsed-JSON one.
 */
interface Capabilities {
  tools: { listChanged: boolean };
  extensions: Record<string, JsonRecord>;
}

/** This server advertises no extensions, so the map is empty rather than absent. */
const CAPABILITIES: Capabilities = {
  tools: { listChanged: false },
  extensions: {},
};

type RequestId = string | number | null | undefined;

/**
 * The `id` to echo. JSON-RPC allows a string, a number or null, and everything
 * else — an absent id, or a client that sent an object — answers as null, which
 * is what the spec asks a server to do when it cannot mirror the id it was given.
 */
function requestId(body: JsonRecord): RequestId {
  const id = body.id;
  return isJsonText(id) || isJsonNumber(id) ? id : null;
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

const NOTE_PROPERTIES = {
  id: { type: 'string', description: 'Opaque note id.' },
  version: { type: 'integer', minimum: 1 },
  title: { type: 'string' },
  body: { type: 'string', description: 'Full unmodified Markdown body.' },
  createdAt: { type: 'string', description: 'ISO-8601 creation timestamp.' },
  updatedAt: { type: 'string', description: 'ISO-8601 timestamp of the last successful content edit.' },
  archivedAt: { anyOf: [{ type: 'string' }, { type: 'null' }] },
} as const;

const NOTE_SCHEMA = {
  type: 'object',
  properties: NOTE_PROPERTIES,
  required: ['id', 'version', 'title', 'body', 'createdAt', 'updatedAt', 'archivedAt'],
  additionalProperties: false,
} as const;

const NOTE_SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    id: NOTE_PROPERTIES.id,
    version: NOTE_PROPERTIES.version,
    title: NOTE_PROPERTIES.title,
    createdAt: NOTE_PROPERTIES.createdAt,
    updatedAt: NOTE_PROPERTIES.updatedAt,
    archivedAt: NOTE_PROPERTIES.archivedAt,
    excerpt: { type: 'string', description: 'Approximately 200 characters of derived plain text.' },
  },
  required: ['id', 'version', 'title', 'createdAt', 'updatedAt', 'archivedAt', 'excerpt'],
  additionalProperties: false,
} as const;

const NOTE_PAGE_SCHEMA = {
  type: 'object',
  properties: {
    notes: { type: 'array', items: NOTE_SUMMARY_SCHEMA },
    nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['notes', 'nextCursor'],
  additionalProperties: false,
} as const;

const NOTE_RESULT_SCHEMA = {
  type: 'object',
  properties: { note: NOTE_SCHEMA },
  required: ['note'],
  additionalProperties: false,
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
  {
    name: 'notes_list',
    description:
      'List active notes ordered by most recent successful content edit. Returns metadata and a short plain-text excerpt, never the full Markdown body. Use nextCursor unchanged to fetch another page.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'string', description: 'Opaque nextCursor returned by a previous notes_list call.' },
        limit: { type: 'number', description: 'Page size. Defaults to 50 and is capped at 100.' },
        archived: { type: 'boolean', description: 'List archived notes instead of active notes.' },
      },
      additionalProperties: false,
    },
    outputSchema: NOTE_PAGE_SCHEMA,
  },
  {
    name: 'notes_search',
    description:
      'Full-text search active note titles and Markdown bodies. Results are ordered by last successful edit and contain metadata plus a short excerpt. Call notes_get for the full Markdown.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'FTS words to search for.' },
        cursor: { type: 'string', description: 'Opaque nextCursor from a previous search page.' },
        limit: { type: 'number', description: 'Page size. Defaults to 50 and is capped at 100.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: NOTE_PAGE_SCHEMA,
  },
  {
    name: 'notes_get',
    description:
      'Fetch one note by id, including its full unmodified Markdown body, plain-text title, version, timestamps, and archive state.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Opaque note id from create, list, or search.' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: NOTE_RESULT_SCHEMA,
  },
  {
    name: 'notes_create',
    description:
      'Create a note from a plain-text title and Markdown body. Both strings are stored byte-for-byte; a blank title is valid. Returns the created note at version 1.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Plain-text title. May be blank.' },
        body: { type: 'string', description: 'Markdown body, stored without transformation.' },
      },
      required: ['title', 'body'],
      additionalProperties: false,
    },
    outputSchema: NOTE_RESULT_SCHEMA,
  },
  {
    name: 'notes_update',
    description:
      'Update a note title and/or Markdown body using optimistic concurrency. expectedVersion is mandatory. A stale write is retained as a conflict revision and returns code stale_version with the current version and attempted revision id.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Note id.' },
        expectedVersion: { type: 'number', description: 'Version returned by the last get/list/search/create/update.' },
        title: { type: 'string', description: 'Replacement plain-text title. Omit to keep it unchanged.' },
        body: { type: 'string', description: 'Replacement Markdown body. Omit to keep it unchanged.' },
      },
      required: ['id', 'expectedVersion'],
      additionalProperties: false,
    },
    outputSchema: {
      anyOf: [
        {
          type: 'object',
          properties: { note: NOTE_SCHEMA, changed: { type: 'boolean' } },
          required: ['note', 'changed'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            error: { type: 'string' },
            conflict: { const: true },
            code: { const: 'stale_version' },
            noteId: { type: 'string' },
            expectedVersion: { type: 'integer' },
            currentVersion: { type: 'integer' },
            attemptedRevisionId: { type: 'string' },
          },
          required: ['error', 'conflict', 'code', 'noteId', 'expectedVersion', 'currentVersion', 'attemptedRevisionId'],
          additionalProperties: false,
        },
      ],
    },
  },
  {
    name: 'notes_archive',
    description: 'Reversibly archive one note by id. It disappears from active list and search but is never purged.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: NOTE_RESULT_SCHEMA,
  },
  {
    name: 'notes_restore',
    description: 'Restore one archived note by id without changing its version or last-edit ordering timestamp.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Note id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    outputSchema: NOTE_RESULT_SCHEMA,
  },
] as const;

/** Reads the ledger filter arguments the way the REST route reads its query string. */
function ideaFilterFromArgs(args: JsonRecord): IdeaFilter {
  const filter: IdeaFilter = {};
  const status = textField(args, 'status');
  if (status) {
    // Collected one at a time rather than mapped then checked: the guard narrows
    // each part as it lands, so the list is `IdeaStatus[]` by construction and
    // the first bad value still names itself in the refusal.
    const statuses: IdeaStatus[] = [];
    for (const part of status.split(',')) {
      const value = part.trim();
      if (!isIdeaStatus(value)) throw new Error(`invalid status: ${value}`);
      statuses.push(value);
    }
    filter.statuses = statuses;
  }
  const repo = textField(args, 'repo');
  if (repo) filter.repo = repo;
  const area = textField(args, 'area');
  if (area) filter.area = area;
  return filter;
}

function filterFromArgs(args: JsonRecord) {
  return {
    field: textField(args, 'field'),
    skill: textField(args, 'skill'),
    since: textField(args, 'since'),
    hasNotes: flagField(args, 'hasNotes'),
    includeSuperseded: flagField(args, 'includeSuperseded'),
    limit: numberField(args, 'limit'),
  };
}

/**
 * The named arguments, copied across for the `parseIdea*` that will read them.
 *
 * An argument the caller left out stays left out rather than becoming a present
 * `undefined`, which is the difference between "not sent" and "sent as nothing"
 * to a parser that reports on the keys it was given.
 */
function pickArgs(args: JsonRecord, keys: readonly string[]): JsonRecord {
  const picked: JsonRecord = {};
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
}

/** The glossary listing, with facet counts only when they were asked for. */
interface ConceptListPayload {
  count: number;
  concepts: ConceptSummary[];
  facets?: Facets;
}

/**
 * What one tool answers with, before it is JSON-encoded into the MCP result.
 *
 * Enumerated rather than opaque because the transport reads one thing back out of
 * it — whether an `error` key is present, which sets `isError`. The two
 * intersections carry a refusal *and* the result it refused with.
 */
type ToolResult =
  | { error: string }
  | ConceptListPayload
  | { concept: HostedConcept; versions?: HostedConcept[] }
  | { count: number; results: SearchHit[] }
  | { idea: IdeaEntry }
  | IdeasListResult
  | IdeaAddOutcome
  | (IdeaClaimOutcome & { error?: string })
  | IdeaWriteOutcome
  | NotePage
  | { note: Note }
  | { note: Note; changed: boolean }
  | (NoteConflict & { error?: string });

async function callTool(db: Db, name: string, args: JsonRecord): Promise<ToolResult> {
  if (name === 'concepts_list') {
    const filter = filterFromArgs(args);
    const concepts = await listConcepts(db, filter);
    const payload: ConceptListPayload = { count: concepts.length, concepts };
    if (args.facets === true) payload.facets = await conceptFacets(db, filter);
    return payload;
  }

  if (name === 'concepts_get') {
    const id = textField(args, 'id');
    if (id) {
      const concept = await getConceptById(db, id);
      return concept ? { concept } : { error: `no concept with id ${id}` };
    }
    const term = textField(args, 'term');
    if (!term) return { error: 'pass either `term` or `id`' };
    const versions = await getConceptsByTerm(db, term);
    if (versions.length === 0) return { error: `no concept for term "${term}"` };
    return { concept: versions[0]!, versions: versions.slice(1) };
  }

  if (name === 'concepts_search') {
    const query = textField(args, 'query');
    if (!query) return { error: '`query` is required' };
    const results = await searchConcepts(db, query, filterFromArgs(args));
    return { count: results.length, results };
  }

  if (name === 'ideas_list') {
    return await listIdeas(db, ideaFilterFromArgs(args), args.available === true);
  }

  if (name === 'ideas_get') {
    const slug = textField(args, 'slug');
    if (!slug) return { error: '`slug` is required' };
    try {
      const idea = await getIdea(db, slug);
      // Absence is a tool error, not `{ idea: null }` — a successful call must
      // not read as the idea existing and unclaimed.
      return idea ? { idea } : { error: `no idea on the ledger is called ${slug}` };
    } catch (error) {
      // A malformed key comes back in the same `{ error }` shape every other
      // tool refuses with, not the bare `tool … failed:` of an escaped throw.
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
    // Forwarded key by key rather than as a whole-object spread: only what the
    // caller actually sent is handed to the parser, so an argument it omitted
    // reads as omitted there too, and its refusal is the one the CLI would get.
    const [claim] = parseIdeaClaims([pickArgs(args, ['slug', 'by', 'pr'])]);
    const result = await claimIdeas(db, [claim!]);
    // A refusal is reported as a tool error so the model cannot read a plain
    // result as permission to start building what somebody else already is.
    return result.claimed.length > 0 ? result : { error: refusalMessage(result), ...result };
  }

  if (name === 'ideas_mark') {
    const [mark] = parseIdeaMarks([pickArgs(args, ['slug', 'status', 'note'])]);
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

  if (name === 'notes_list') {
    return await listNotes(db, {
      cursor: textField(args, 'cursor'),
      limit: numberField(args, 'limit'),
      archived: args.archived === true,
    });
  }
  if (name === 'notes_search') {
    const query = textField(args, 'query');
    if (!query) return { error: '`query` is required' };
    return await searchNotes(db, query, {
      cursor: textField(args, 'cursor'),
      limit: numberField(args, 'limit'),
    });
  }
  if (name === 'notes_get') {
    const id = textField(args, 'id');
    if (!id) return { error: '`id` is required' };
    const note = await getNote(db, id);
    return note ? { note } : { error: `no note with id ${id}` };
  }
  if (name === 'notes_create') return { note: await createNote(db, args) };
  if (name === 'notes_update') {
    const id = textField(args, 'id');
    if (!id) return { error: '`id` is required' };
    const updated = await updateNote(db, id, args);
    return 'conflict' in updated ? { error: 'stale note version', ...updated } : updated;
  }
  if (name === 'notes_archive' || name === 'notes_restore') {
    const id = textField(args, 'id');
    if (!id) return { error: '`id` is required' };
    return { note: name === 'notes_archive' ? await archiveNote(db, id) : await restoreNote(db, id) };
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

function jsonBody<T>(payload: T, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function result<T>(id: RequestId, value: T): Response {
  return jsonBody({ jsonrpc: '2.0', id: id ?? null, result: value }, 200);
}

async function toolCallResponse(id: RequestId, db: Db, name: string, args: JsonRecord): Promise<Response> {
  try {
    const payload = await callTool(db, name, args);
    // An error payload is a correctable tool refusal, not a transport failure.
    return result(id, {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      structuredContent: payload,
      isError: 'error' in payload,
    });
  } catch (error) {
    return result(id, {
      content: [
        { type: 'text', text: `tool ${name} failed: ${error instanceof Error ? error.message : String(error)}` },
      ],
      isError: true,
    });
  }
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

function metaProtocolVersion(params: JsonRecord): string | undefined {
  const meta = recordField(params, '_meta');
  return meta ? textField(meta, META_PROTOCOL_VERSION) : undefined;
}

/**
 * The headers the transport mirrors from the body. Required, and a value that
 * disagrees with the body is rejected rather than reconciled.
 */
function mirroredHeaderMismatch(request: Request, method: string, params: JsonRecord): string | null {
  const headerMethod = request.headers.get('mcp-method');
  if (!headerMethod) return 'missing required header Mcp-Method';
  if (headerMethod !== method) return `Mcp-Method header "${headerMethod}" does not match body method "${method}"`;

  // Mcp-Name mirrors `params.name` (or `params.uri`); only tools/call has one here.
  if (method === 'tools/call') {
    const headerName = request.headers.get('mcp-name');
    if (!headerName) return 'missing required header Mcp-Name';
    const bodyName = isJsonText(params.name) ? params.name : '';
    const decoded = decodeHeaderValue(headerName);
    if (decoded !== bodyName) return `Mcp-Name header "${decoded}" does not match body name "${bodyName}"`;
  }

  return null;
}

export async function handleMcp(request: Request, db: Db): Promise<Response> {
  // No GET stream and no session to DELETE: this server never initiates a message.
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });

  const body = await readJsonRecord(request);
  const method = body && textField(body, 'method');
  if (!body || !method) return rpcError(null, -32700, 'parse error', 400);
  const id = requestId(body);
  const params = recordField(body, 'params') ?? {};

  // Codex negotiates 2025-06-18 without requiring server-side session state.
  if (method === 'initialize') {
    const requested = isJsonText(params.protocolVersion) ? params.protocolVersion : null;
    if (requested !== LEGACY_PROTOCOL_VERSION) {
      return unsupportedVersion(id, requested, 'unsupported protocol version');
    }
    return result(id, {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
      capabilities: { tools: CAPABILITIES.tools },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    });
  }

  const headerVersion = request.headers.get('mcp-protocol-version');

  // The legacy initialized notification creates no server-side state.
  if (method === 'notifications/initialized' && headerVersion !== MODERN_PROTOCOL_VERSION) {
    return new Response(null, { status: 202 });
  }

  if (method.startsWith('notifications/')) {
    return rpcError(null, -32600, `no client notification is defined by this protocol revision: ${method}`, 400);
  }

  // Legacy requests use only the negotiated header, without modern mirrored metadata.
  if (headerVersion === LEGACY_PROTOCOL_VERSION) {
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: TOOLS });
    if (method === 'tools/call') {
      const name = isJsonText(params.name) ? params.name : '';
      const args = recordField(params, 'arguments') ?? {};
      return await toolCallResponse(id, db, name, args);
    }
    return rpcError(id, -32601, `method not found: ${method}`, 404);
  }

  // Modern requests declare matching versions in the header and `params._meta`.
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
      instructions: SERVER_INSTRUCTIONS,
      _meta: { [META_SERVER_INFO]: SERVER_INFO },
    });
  }

  if (method === 'ping') return result(id, {});

  if (method === 'tools/list') return result(id, { tools: TOOLS });

  if (method === 'tools/call') {
    const name = isJsonText(params.name) ? params.name : '';
    const args = recordField(params, 'arguments') ?? {};
    return await toolCallResponse(id, db, name, args);
  }

  // 404 with a JSON-RPC body, which distinguishes a modern MCP endpoint from a
  // host that serves no MCP at all.
  return rpcError(id, -32601, `method not found: ${method}`, 404);
}
