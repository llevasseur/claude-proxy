import {
  type IdeaFilter,
  isIdeaArea,
  isIdeaRepo,
  isIdeaStatus,
  parseIdeaAdds,
  parseIdeaClaims,
  parseIdeaComments,
  parseIdeaFilings,
  parseIdeaMarks,
} from '@agent-proxy/claude-core';
import type { Db } from './db.ts';
import {
  addIdeas,
  claimIdeas,
  commentIdeas,
  exportIdeas,
  fileIdeas,
  getIdea,
  IdeaError,
  listIdeas,
  markIdeas,
} from './ideas.ts';
import { readJsonBody, readJsonRecord, textField } from './json.ts';
import {
  archiveNote,
  createNote,
  getNote,
  listNotes,
  NoteError,
  restoreNote,
  searchNotes,
  updateNote,
} from './notes.ts';
import {
  ConceptError,
  type ConceptFilter,
  type ConceptSummary,
  conceptFacets,
  exportJsonl,
  type Facets,
  getConceptById,
  getConceptsByTerm,
  listConcepts,
  saveConcept,
  searchConcepts,
} from './store.ts';

export function json<T>(body: T, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

/** Reads the shared filter parameters that `list` and `search` both accept. */
export function filterFromParams(params: URLSearchParams): ConceptFilter {
  const filter: ConceptFilter = {};
  const field = params.get('field');
  if (field) filter.field = field;
  const skill = params.get('skill');
  if (skill) filter.skill = skill;
  const since = params.get('since');
  if (since) filter.since = since;
  if (params.get('hasNotes') === 'true') filter.hasNotes = true;
  if (params.get('includeSuperseded') === 'true') filter.includeSuperseded = true;
  const limit = params.get('limit');
  if (limit) filter.limit = Number(limit);
  return filter;
}

/** The listing body: the glossary, its size, and the facet counts when they were asked for. */
interface ConceptListBody {
  concepts: ConceptSummary[];
  count: number;
  facets?: Facets;
}

/**
 * Handles the REST surface, or returns null when the path is not one of ours so
 * the caller can fall through to MCP.
 */
export async function handleRest(request: Request, url: URL, db: Db): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const params = url.searchParams;

  if (path === '/api/concepts' && request.method === 'POST') {
    const result = await saveConcept(db, await readJsonBody(request));
    return json(
      { id: result.concept.id, term: result.concept.term, created: result.created },
      result.created ? 201 : 200,
    );
  }

  if (path === '/api/concepts' && request.method === 'GET') {
    const filter = filterFromParams(params);
    const concepts = await listConcepts(db, filter);
    const body: ConceptListBody = { concepts, count: concepts.length };
    // Facets are a second query, so they are computed only when asked for — and
    // the key stays off the body entirely when they were not.
    if (params.get('facets') === 'true') body.facets = await conceptFacets(db, filter);
    return json(body);
  }

  if (path === '/api/concepts/concept' && request.method === 'GET') {
    const id = params.get('id');
    if (id) {
      const concept = await getConceptById(db, id);
      if (!concept) throw new ConceptError(404, `no concept with id ${id}`);
      return json({ concept });
    }
    const term = params.get('term');
    if (!term) throw new ConceptError(400, 'pass either `id` or `term`');
    const versions = await getConceptsByTerm(db, term);
    if (versions.length === 0) throw new ConceptError(404, `no concept for term ${term}`);
    // Newest first, with the older versions alongside rather than discarded.
    return json({ concept: versions[0]!, versions });
  }

  if (path === '/api/concepts/search' && request.method === 'GET') {
    const query = params.get('q');
    if (!query) throw new ConceptError(400, '`q` is required');
    const results = await searchConcepts(db, query, filterFromParams(params));
    return json({ results, count: results.length });
  }

  if (path === '/api/concepts/export' && request.method === 'GET') {
    return new Response(await exportJsonl(db), {
      headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
    });
  }

  if (path.startsWith('/api/ideas')) return handleIdeas(request, path, params, db);

  if (path.startsWith('/api/notes')) return handleNotes(request, path, params, db);

  return null;
}

function noteLimit(params: URLSearchParams): number | undefined {
  const value = params.get('limit');
  return value === null ? undefined : Number(value);
}

async function handleNotes(request: Request, path: string, params: URLSearchParams, db: Db): Promise<Response> {
  if (path === '/api/notes' && request.method === 'GET') {
    return json(
      await listNotes(db, {
        cursor: params.get('cursor') ?? undefined,
        limit: noteLimit(params),
        archived: params.get('archived') === 'true',
      }),
    );
  }
  if (path === '/api/notes/search' && request.method === 'GET') {
    return json(
      await searchNotes(db, params.get('q') ?? '', {
        cursor: params.get('cursor') ?? undefined,
        limit: noteLimit(params),
      }),
    );
  }
  if (path === '/api/notes/note' && request.method === 'GET') {
    const id = params.get('id');
    if (!id) throw new NoteError(400, '`id` is required');
    const note = await getNote(db, id);
    if (!note) throw new NoteError(404, `no note with id ${id}`);
    return json({ note });
  }
  if (path === '/api/notes' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    if (!body) throw new NoteError(400, 'JSON body is required');
    return json({ note: await createNote(db, body) }, 201);
  }
  if (path === '/api/notes/update' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    const id = body && textField(body, 'id');
    if (!id) throw new NoteError(400, '`id` is required');
    const result = await updateNote(db, id, body ?? {});
    return 'conflict' in result ? json(result, 409) : json(result);
  }
  if ((path === '/api/notes/archive' || path === '/api/notes/restore') && request.method === 'POST') {
    const body = await readJsonRecord(request);
    const id = body && textField(body, 'id');
    if (!id) throw new NoteError(400, '`id` is required');
    const note = path.endsWith('/archive') ? await archiveNote(db, id) : await restoreNote(db, id);
    return json({ note });
  }
  throw new NoteError(404, `no route for ${request.method} ${path}`);
}

/** Reads `?status=`, `?repo=` and `?area=` the way the local server's route does. */
function ideaFilterFromParams(params: URLSearchParams): IdeaFilter {
  const filter: IdeaFilter = {};
  const status = params.get('status');
  if (status) {
    filter.statuses = status.split(',').map((part) => {
      const value = part.trim();
      if (!isIdeaStatus(value)) throw new IdeaError(400, `invalid status: ${value}`);
      return value;
    });
  }
  const repo = params.get('repo');
  if (repo) {
    // A checkout path names a different thing on another machine, and this
    // ledger is now shared across every machine rather than only every repo.
    if (!isIdeaRepo(repo))
      throw new IdeaError(400, `invalid repo: ${repo} (expected a git remote slug like owner/name)`);
    filter.repo = repo;
  }
  const area = params.get('area');
  if (area) {
    if (!isIdeaArea(area)) throw new IdeaError(400, `invalid area: ${area} (expected a kebab-case slug)`);
    filter.area = area;
  }
  return filter;
}

/** A parse refusal from `packages/core` is the client's fault, so it is a 400 rather than a 500. */
function parsed<T>(read: () => T): T {
  try {
    return read();
  } catch (error) {
    throw new IdeaError(400, error instanceof Error ? error.message : String(error));
  }
}

/**
 * The ideas surface. See ADR 0006.
 *
 * Every write takes the same batch shape the local CLI and the dashboard already
 * post, and is parsed by the same `parseIdea*` functions, so a refusal here is
 * word for word the refusal a caller would have got from the file.
 */
async function handleIdeas(request: Request, path: string, params: URLSearchParams, db: Db): Promise<Response> {
  if (path === '/api/ideas/export' && request.method === 'GET') {
    return new Response(await exportIdeas(db), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  if (path === '/api/ideas' && request.method === 'GET') {
    return json(await listIdeas(db, ideaFilterFromParams(params), params.get('available') === 'true'));
  }

  // One idea by its key, the sibling of `/api/concepts/concept`.
  if (path === '/api/ideas/idea' && request.method === 'GET') {
    const slug = params.get('slug');
    if (!slug) throw new IdeaError(400, '`slug` is required');
    const idea = await getIdea(db, slug);
    if (!idea) throw new IdeaError(404, `no idea on the ledger is called ${slug}`);
    return json({ idea });
  }

  if (path === '/api/ideas' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    return json(
      await addIdeas(
        db,
        parsed(() => parseIdeaAdds(body?.ideas)),
      ),
    );
  }

  if (path === '/api/ideas/mark' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    return json(
      await markIdeas(
        db,
        parsed(() => parseIdeaMarks(body?.marks)),
      ),
    );
  }

  if (path === '/api/ideas/file' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    return json(
      await fileIdeas(
        db,
        parsed(() => parseIdeaFilings(body?.filings)),
      ),
    );
  }

  if (path === '/api/ideas/comment' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    return json(
      await commentIdeas(
        db,
        parsed(() => parseIdeaComments(body?.comments)),
      ),
    );
  }

  if (path === '/api/ideas/claim' && request.method === 'POST') {
    const body = await readJsonRecord(request);
    // A live holder comes back in the body as a refusal rather than as an error
    // status: it is an answer the caller renders, not a failed request.
    return json(
      await claimIdeas(
        db,
        parsed(() => parseIdeaClaims(body?.claims)),
      ),
    );
  }

  throw new IdeaError(404, `no route for ${request.method} ${path}`);
}
