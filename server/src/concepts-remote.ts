/**
 * The hosted concept store — `services/concepts` on Cloudflare — read over its
 * REST surface. `server/src/concepts.ts` still reads `logs/concepts.jsonl`, and
 * still answers when this one is not configured.
 *
 * **Credentials come from `process.env` and go nowhere else.** They are read per
 * call rather than captured at import, and neither value is ever logged, written
 * to a file, or put in a response body.
 *
 * The read goes to `GET /api/concepts/export`, not the listing route: the
 * listing is compact — it drops `notes`, `tips`, `sources` and
 * `surfacedSkills`, and returns the newest version per term — while the export
 * returns every version, oldest first, as the same JSONL the local reader
 * already parses.
 *
 * `ord` stays **the record's position in the corpus ordered oldest-first**
 * rather than the Worker's ULID row id, and is assigned from the export's own
 * `saved_at ASC, id ASC` order — the order the file was appended in and the
 * database seeded from, so existing `/concepts/<n>` permalinks resolve to the
 * same concept. It stays stable because the store is append-only.
 */

import { type StoredConcept, sortConcepts } from '@claude-proxy/core';
import { parseConceptStore } from './concepts.js';

/** The whole corpus, oldest first, in `logs/concepts.jsonl`'s own format. */
const EXPORT_PATH = '/api/concepts/export';

/** The store's own ranked search. Its bm25 index spans the whole record, `notes` included. */
const SEARCH_PATH = '/api/concepts/search';

/** A ceiling rather than a page size, matching the store's own `MAX_LIMIT`. */
const SEARCH_LIMIT = 1000;

/** A configured hosted store: where it is, and the bearer token to read it. */
export interface RemoteConceptStore {
  /** The Worker's base URL, without a trailing slash. */
  origin: string;
  token: string;
}

/**
 * The hosted store, or `null` when this device is not configured for one.
 *
 * Both variables are required; either one missing means the local file answers
 * instead, which is the documented fallback rather than an error.
 */
export function remoteConceptStore(): RemoteConceptStore | null {
  const origin = process.env.CONCEPTS_URL?.trim();
  const token = process.env.CONCEPTS_TOKEN?.trim();
  if (!origin || !token) return null;
  return { origin: origin.replace(/\/+$/, ''), token };
}

/** The URL a read is issued to. */
function exportUrl(store: RemoteConceptStore): string {
  return `${store.origin}${EXPORT_PATH}`;
}

/**
 * A requested URL reduced to what is safe to show a reader: `origin` +
 * `pathname` and nothing else.
 *
 * Dropping the query string is not tidiness — it is what keeps a credential in
 * a configured URL, and the reader's own search text, out of a response body and
 * out of an error message. An unparseable URL is reported by its path alone for
 * the same reason.
 */
function safeLabel(requested: string, fallbackPath: string): string {
  try {
    const url = new URL(requested);
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallbackPath;
  }
}

/**
 * The URL a read goes to, safe to show a reader.
 *
 * Derived from {@link exportUrl}, so a configured URL carrying a path prefix
 * cannot make the label name an address that was never requested.
 */
export function remoteConceptStoreLabel(store: RemoteConceptStore): string {
  return safeLabel(exportUrl(store), EXPORT_PATH);
}

/** A read that did not produce a corpus. The server answers it as a 502. */
export class RemoteConceptStoreError extends Error {
  constructor(message: string) {
    super(`concept store unreachable: ${message}`);
    this.name = 'RemoteConceptStoreError';
  }
}

/**
 * Every concept the hosted store holds, newest first, each carrying its `ord`.
 *
 * A failure **throws** rather than falling back to the local file — a
 * plausible-looking page answered by the wrong store, with nothing on it saying
 * so, is the failure this exists to remove.
 */
export async function readRemoteConcepts(store: RemoteConceptStore): Promise<StoredConcept[]> {
  const label = remoteConceptStoreLabel(store);
  let response: Response;
  try {
    response = await fetch(exportUrl(store), {
      headers: { authorization: `Bearer ${store.token}` },
    });
  } catch (err) {
    throw new RemoteConceptStoreError(`${label} (${(err as Error).message})`);
  }
  if (!response.ok) throw new RemoteConceptStoreError(`${label} answered ${response.status}`);

  const text = await response.text();
  // Same parse as the file, so a torn or unknown record degrades identically;
  // `ord` is the export's own oldest-first position.
  return sortConcepts(parseConceptStore(text).map((concept, ord) => ({ ...concept, ord })));
}

/**
 * One ranked hit, reduced to what identifies the record and how well it scored.
 *
 * The store answers with the whole record, and the whole record is deliberately
 * dropped here: the corpus read by {@link readRemoteConcepts} is what the page
 * renders — it carries `ord`, which a hit does not — so a hit's only job is to
 * say *which* corpus record matched and in what order. `term` plus `savedAt` is
 * that identity, the store having no key the export exposes.
 */
export interface RemoteConceptHit {
  term: string;
  savedAt: string;
  /** bm25 relevance, higher is better. */
  score: number;
}

/** A hit as the store sends it, before it is narrowed to the fields above. */
function toHit(value: unknown): RemoteConceptHit | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.term !== 'string' || typeof row.savedAt !== 'string') return null;
  return { term: row.term, savedAt: row.savedAt, score: typeof row.score === 'number' ? row.score : 0 };
}

/**
 * The store's ranked answer for `query`, best first.
 *
 * `includeSuperseded` is set because the corpus this ranks is the export, where
 * a term taught twice appears twice — the store's default keeps only the newest
 * version per term, which would rank a hit the page still lists as absent.
 *
 * A failure **throws**, exactly as the corpus read does: a search that quietly
 * answers nothing is indistinguishable from a corpus that holds nothing, which
 * is the failure this module exists to keep off the page.
 */
export async function searchRemoteConcepts(store: RemoteConceptStore, query: string): Promise<RemoteConceptHit[]> {
  const url = new URL(`${store.origin}${SEARCH_PATH}`);
  url.searchParams.set('q', query);
  url.searchParams.set('includeSuperseded', 'true');
  url.searchParams.set('limit', String(SEARCH_LIMIT));
  // Names the route, never the query text and never a credential in the origin.
  const label = safeLabel(url.toString(), SEARCH_PATH);

  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${store.token}` } });
  } catch (err) {
    throw new RemoteConceptStoreError(`${label} (${(err as Error).message})`);
  }
  if (!response.ok) throw new RemoteConceptStoreError(`${label} answered ${response.status}`);

  const body = (await response.json().catch(() => null)) as { results?: unknown } | null;
  const results = Array.isArray(body?.results) ? body.results : [];
  // Read defensively, like the corpus parse: a row this code does not recognise
  // is dropped from the ranking rather than emptying it.
  return results.map(toHit).filter((hit): hit is RemoteConceptHit => hit !== null);
}
