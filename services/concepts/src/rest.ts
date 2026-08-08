import type { Db } from './db.ts';
import {
  ConceptError,
  type ConceptFilter,
  conceptFacets,
  exportJsonl,
  getConceptById,
  getConceptsByTerm,
  listConcepts,
  saveConcept,
  searchConcepts,
} from './store.ts';

export function json(body: unknown, status = 200): Response {
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

/**
 * Handles the REST surface, or returns null when the path is not one of ours so
 * the caller can fall through to MCP.
 */
export async function handleRest(request: Request, url: URL, db: Db): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const params = url.searchParams;

  if (path === '/api/concepts' && request.method === 'POST') {
    const body = await request.json().catch(() => null);
    const result = await saveConcept(db, body);
    return json(
      { id: result.concept.id, term: result.concept.term, created: result.created },
      result.created ? 201 : 200,
    );
  }

  if (path === '/api/concepts' && request.method === 'GET') {
    const filter = filterFromParams(params);
    const concepts = await listConcepts(db, filter);
    const body: Record<string, unknown> = { concepts, count: concepts.length };
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

  return null;
}
