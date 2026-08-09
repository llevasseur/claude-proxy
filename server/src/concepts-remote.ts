/**
 * The hosted concept store — `services/concepts` on Cloudflare — read over its
 * REST surface.
 *
 * `/teach` posts every concept here from whichever device ran it, so this is the
 * only store that holds the whole corpus. `server/src/concepts.ts` still reads
 * `logs/concepts.jsonl`, and still answers when this one is not configured; see
 * `docs/adrs/0005-host-the-concept-store.md` for the three-step rollout that
 * ends with the local file retired.
 *
 * **Credentials come from `process.env` and go nowhere else.** They are read on
 * every call rather than captured at import, so a process that gains them does
 * not need restarting to use them, and neither value is ever logged, written to
 * a file, or put in a response body.
 *
 * ## Why `export` and not the listing route
 *
 * `GET /api/concepts` is a *compact* listing: it drops `notes`, `tips`,
 * `sources` and `surfacedSkills`, and it returns the newest version per term
 * unless asked otherwise. Neither is what this reader wants. The dashboard's
 * detail page renders exactly those dropped fields, and the Concepts page's
 * whole reading of itself is that **a term taught twice appears twice**.
 * `GET /api/concepts/export` returns every version, oldest first, as the same
 * JSONL `logs/concepts.jsonl` holds — so the remote answer is byte-for-byte the
 * shape the local reader already parses, and one request answers both routes.
 *
 * ## How a Worker row id maps to `ord`
 *
 * It does not, and deliberately. A Worker row is keyed by a ULID; the dashboard
 * addresses a concept by `ord`, the line the record sits on. Handing the ULID
 * out as the identifier would change the wire shape the admin app consumes and
 * break every `/concepts/<n>` permalink already in existence.
 *
 * So `ord` keeps its meaning — **the record's position in the corpus ordered
 * oldest-first** — and is assigned here from the export's own order, which is
 * `saved_at ASC, id ASC`. That is the order `logs/concepts.jsonl` was appended
 * in and the order `services/concepts/scripts/import-store.ts` seeded the
 * database from, so line *n* of the file is row *n* of the export and existing
 * permalinks resolve to the same concept they always did. It stays stable for
 * the same reason the file's line numbers did: the store is append-only, and a
 * newer concept sorts after every existing one rather than in front of it.
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
 * Both variables are required: a URL without a token cannot be read, and a
 * token without a URL has nothing to read. Either one missing means the local
 * file answers instead, which is the documented fallback rather than an error.
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
 * configured URL — a `?token=` query, a `user:pass@` userinfo — cannot ride
 * along into a response body or an error message. An unparseable URL is
 * reported by its path alone for the same reason.
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
 * A failure **throws** rather than falling back to the local file. Serving the
 * local store under a remote configuration is the exact failure this whole
 * change exists to remove: a plausible-looking page answered by the wrong
 * store, with nothing on it saying so.
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
  // Same parse as the file, so a torn or unknown record degrades identically,
  // and `ord` is the export's own oldest-first position — see the note above.
  return sortConcepts(parseConceptStore(text).map((concept, ord) => ({ ...concept, ord })));
}
