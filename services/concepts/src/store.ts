import { type Concept, isConcept, normalizeConcept, withoutMetaSkills } from '@claude-proxy/core';
import type { Db, DbStatement, DbValue } from './db.ts';
import { seedBytes, ulid } from './ulid.ts';

/** A concept as the store returns it: the record itself, plus its row id. */
export interface HostedConcept extends Concept {
  id: string;
}

/** The listing shape: everything but the prose. */
export interface ConceptSummary {
  id: string;
  term: string;
  sentence: string;
  field: string;
  skills: string[];
  savedAt: string;
  hasNotes: boolean;
}

export interface ConceptFilter {
  field?: string;
  skill?: string;
  /** ISO timestamp; matches records saved at or after it. */
  since?: string;
  hasNotes?: boolean;
  /** Include superseded versions of a term. Default false — newest wins. */
  includeSuperseded?: boolean;
  limit?: number;
}

export interface Facet {
  value: string;
  count: number;
}

export interface Facets {
  fields: Facet[];
  skills: Facet[];
}

export interface SearchHit extends HostedConcept {
  /** bm25 relevance, higher is better. */
  score: number;
}

const MAX_LIMIT = 1000;

/** Separator for the packed skills column — a skill may legitimately contain a comma. */
const UNIT_SEPARATOR = '\u001F';

/** An error carrying the status the REST layer should answer with. */
export class ConceptError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ConceptError';
    this.status = status;
  }
}

/**
 * Two records are the same concept when their terms match case- and
 * whitespace-insensitively.
 */
function termKey(term: string): string {
  return term.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The newest-per-term predicate: keep a row only when no other row for the same
 * term is newer. Correlated NOT EXISTS so it walks `concept_term_key` directly.
 */
const CURRENT_ONLY = `NOT EXISTS (
    SELECT 1 FROM concept newer
    WHERE newer.term_key = c.term_key
      AND (newer.saved_at > c.saved_at OR (newer.saved_at = c.saved_at AND newer.id > c.id))
  )`;

interface Where {
  clause: string;
  params: DbValue[];
}

function buildWhere(filter: ConceptFilter): Where {
  const clauses: string[] = [];
  const params: DbValue[] = [];
  if (!filter.includeSuperseded) clauses.push(CURRENT_ONLY);
  if (filter.field) {
    clauses.push('c.field = ?');
    params.push(filter.field);
  }
  if (filter.skill) {
    clauses.push('EXISTS (SELECT 1 FROM concept_skill s WHERE s.id = c.id AND s.skill = ?)');
    params.push(filter.skill);
  }
  if (filter.since) {
    clauses.push('c.saved_at >= ?');
    params.push(filter.since);
  }
  if (filter.hasNotes) clauses.push('c.has_notes = 1');
  return { clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return MAX_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

interface DocumentRow {
  id: string;
  document: string;
}

function hydrate(row: DocumentRow): HostedConcept {
  // `document` is the record verbatim — the only representation that still
  // distinguishes an absent optional field from an empty one.
  return { ...(JSON.parse(row.document) as Concept), id: row.id };
}

/** Canonical serialization — the id is derived from this, so it must be stable. */
function documentOf(concept: Concept): string {
  return JSON.stringify(normalizeConcept(concept));
}

async function idFor(concept: Concept, document: string): Promise<string> {
  const parsed = Date.parse(concept.savedAt);
  const timeMs = Number.isNaN(parsed) ? Date.now() : parsed;
  return ulid(timeMs, await seedBytes(document));
}

export interface SaveResult {
  concept: HostedConcept;
  /** False when this exact record was already stored — a replayed write. */
  created: boolean;
}

export async function saveConcept(db: Db, input: unknown): Promise<SaveResult> {
  if (!isConcept(input)) throw new ConceptError(400, 'body must be a concept with string `term` and `savedAt`');
  const concept = normalizeConcept(input);
  const document = documentOf(concept);
  const id = await idFor(concept, document);

  const existing = await db.all<DocumentRow>('SELECT id, document FROM concept WHERE id = ?', [id]);
  if (existing.length > 0) return { concept: hydrate(existing[0]!), created: false };

  const statements: DbStatement[] = [
    {
      sql: `INSERT OR IGNORE INTO concept (id, term, term_key, sentence, field, saved_at, has_notes, document)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
        concept.term,
        termKey(concept.term),
        concept.sentence,
        concept.field,
        concept.savedAt,
        concept.notes ? 1 : 0,
        document,
      ],
    },
  ];

  // Meta skills stay in `document` but out of the facet table, so grouping by
  // skill does not rank routing machinery above subject matter.
  withoutMetaSkills(concept.skills).forEach((skill, index) => {
    statements.push({
      sql: 'INSERT OR IGNORE INTO concept_skill (id, skill_ord, skill) VALUES (?, ?, ?)',
      params: [id, index, skill],
    });
  });

  const items: [string, readonly string[] | undefined][] = [
    ['tip', concept.tips],
    ['source', concept.sources],
    ['surfaced_skill', concept.surfacedSkills],
  ];
  for (const [kind, values] of items) {
    (values ?? []).forEach((item, index) => {
      statements.push({
        sql: 'INSERT OR IGNORE INTO concept_item (id, kind, item_ord, item) VALUES (?, ?, ?, ?)',
        params: [id, kind, index, item],
      });
    });
  }

  statements.push({
    sql: 'INSERT INTO concept_fts (id, term, sentence, notes, tips) VALUES (?, ?, ?, ?, ?)',
    params: [id, concept.term, concept.sentence, concept.notes ?? '', (concept.tips ?? []).join('\n')],
  });

  await db.batch(statements);
  return { concept: { ...concept, id }, created: true };
}

export async function listConcepts(db: Db, filter: ConceptFilter = {}): Promise<ConceptSummary[]> {
  const where = buildWhere(filter);
  const rows = await db.all<{
    id: string;
    term: string;
    sentence: string;
    field: string;
    saved_at: string;
    has_notes: number;
    skills: string | null;
  }>(
    `SELECT c.id, c.term, c.sentence, c.field, c.saved_at, c.has_notes,
            (SELECT group_concat(skill, char(31))
              FROM (SELECT skill FROM concept_skill WHERE id = c.id ORDER BY skill_ord)) AS skills
     FROM concept c
     ${where.clause}
     ORDER BY c.saved_at DESC, c.id DESC
     LIMIT ?`,
    [...where.params, boundedLimit(filter.limit)],
  );
  return rows.map((row) => ({
    id: row.id,
    term: row.term,
    sentence: row.sentence,
    field: row.field,
    skills: row.skills ? row.skills.split(UNIT_SEPARATOR) : [],
    savedAt: row.saved_at,
    hasNotes: row.has_notes === 1,
  }));
}

export async function getConceptById(db: Db, id: string): Promise<HostedConcept | null> {
  const rows = await db.all<DocumentRow>('SELECT id, document FROM concept WHERE id = ?', [id]);
  return rows.length > 0 ? hydrate(rows[0]!) : null;
}

/** Every version of a term, newest first. */
export async function getConceptsByTerm(db: Db, term: string): Promise<HostedConcept[]> {
  const rows = await db.all<DocumentRow>(
    'SELECT id, document FROM concept c WHERE c.term_key = ? ORDER BY c.saved_at DESC, c.id DESC',
    [termKey(term)],
  );
  return rows.map(hydrate);
}

/**
 * Turns free text into an FTS5 query that cannot throw: every bare token is
 * quoted so punctuation is matched literally rather than parsed as an operator,
 * while `AND`/`OR`/`NOT` in caps still pass through.
 */
export function toMatchQuery(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const parts = tokens.map((token) => {
    if (token === 'AND' || token === 'OR' || token === 'NOT') return token;
    return `"${token.replace(/"/g, '""')}"`;
  });
  return parts.join(' ');
}

export async function searchConcepts(db: Db, query: string, filter: ConceptFilter = {}): Promise<SearchHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];
  const where = buildWhere(filter);
  const conditions = where.clause ? `${where.clause} AND concept_fts MATCH ?` : 'WHERE concept_fts MATCH ?';
  const rows = await db.all<DocumentRow & { score: number }>(
    `SELECT c.id AS id, c.document AS document,
            -bm25(concept_fts, 10.0, 5.0, 2.0, 1.0) AS score
     FROM concept_fts
     JOIN concept c ON c.id = concept_fts.id
     ${conditions}
     ORDER BY score DESC
     LIMIT ?`,
    [...where.params, match, boundedLimit(filter.limit)],
  );
  // bm25() is more negative for a better hit; negating it above gives the
  // ordinary "higher is better" score.
  return rows.map((row) => ({ ...hydrate(row), score: row.score }));
}

export async function conceptFacets(db: Db, filter: ConceptFilter = {}): Promise<Facets> {
  const where = buildWhere(filter);
  const fields = await db.all<Facet>(
    `SELECT c.field AS value, COUNT(*) AS count
     FROM concept c ${where.clause}
     GROUP BY c.field ORDER BY count DESC, value ASC`,
    where.params,
  );
  const skills = await db.all<Facet>(
    `SELECT s.skill AS value, COUNT(*) AS count
     FROM concept c JOIN concept_skill s ON s.id = c.id
     ${where.clause}
     GROUP BY s.skill ORDER BY count DESC, value ASC`,
    where.params,
  );
  return { fields, skills };
}

/**
 * The whole corpus as JSONL, oldest first — every version, not just the current
 * ones. Same format as `logs/concepts.jsonl`, so a restore is an ordinary import.
 */
export async function exportJsonl(db: Db): Promise<string> {
  const rows = await db.all<{ document: string }>('SELECT document FROM concept c ORDER BY c.saved_at ASC, c.id ASC');
  return rows.map((row) => row.document).join('\n');
}
