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

/**
 * The URL a read goes to, safe to show a reader.
 *
 * Rebuilt from `origin` + `pathname` so that a credential someone put in the
 * configured URL cannot ride along into a response body or an error message. An
 * unparseable URL is reported by its path alone for the same reason.
 */
export function remoteConceptStoreLabel(store: RemoteConceptStore): string {
  try {
    const url = new URL(EXPORT_PATH, `${store.origin}/`);
    return `${url.origin}${url.pathname}`;
  } catch {
    return EXPORT_PATH;
  }
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
    response = await fetch(`${store.origin}${EXPORT_PATH}`, {
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
