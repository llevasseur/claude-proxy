/**
 * The hosted ideas ledger — the `operator` Worker in `services/concepts` —
 * reached over its REST surface. See ADR 0006.
 *
 * **There is no local fallback, and that is the single most important thing
 * about this file.** `concepts-remote.ts` returns `null` when the device is
 * unconfigured and lets `logs/concepts.jsonl` answer, which is right there: the
 * corpus is additive and the worst case is one concept saved nowhere. Here it
 * would be the failure ADR 0005 was written to kill, arriving through the
 * mitigation: an unconfigured device would keep a **second, divergent,
 * complete-looking ledger**, re-propose everything the shared one already
 * rejected, and record decisions nobody else can see. So this module throws,
 * naming the two variables it wants, and a device that cannot reach the ledger
 * does no ideas work at all.
 *
 * **Credentials come from `process.env` and go nowhere else.** They are read per
 * call rather than captured at import, and neither value is ever logged, written
 * to a file, or put in a response body.
 */

import { type IdeasStore, parseIdeasStore } from '@claude-proxy/core';

/** A configured hosted ledger: where it is, and the bearer token to reach it. */
export interface RemoteIdeasStore {
  /** The Worker's base URL, without a trailing slash. */
  origin: string;
  token: string;
}

/** A read or write that did not reach the ledger. The server answers it as a 502. */
export class RemoteIdeasStoreError extends Error {
  constructor(message: string) {
    super(`ideas ledger unreachable: ${message}`);
    this.name = 'RemoteIdeasStoreError';
  }
}

/**
 * Raised when the device has no hosted ledger configured.
 *
 * Deliberately **not** the same error as one that could not be reached: this one
 * is a setup problem with a fix the message states, while the other is a
 * transient. Both refuse; neither falls back.
 */
export class IdeasStoreUnconfiguredError extends Error {
  constructor() {
    super(
      'this device has no ideas ledger configured: set IDEAS_URL and IDEAS_TOKEN to the operator Worker. ' +
        'There is deliberately no local fallback — a device writing to logs/ideas.json instead would keep a ' +
        'second ledger that looks complete, and would re-propose ideas the shared one already rejected.',
    );
    this.name = 'IdeasStoreUnconfiguredError';
  }
}

/**
 * The hosted ledger, or a throw naming what is missing.
 *
 * `CONCEPTS_URL`/`CONCEPTS_TOKEN` are accepted as a fallback **for the address
 * only**, because both datasets live on one Worker behind one token: a device
 * already configured for concepts is already configured for this. `IDEAS_*`
 * wins where both are set, so the two can be split later without a migration.
 */
export function requireRemoteIdeasStore(): RemoteIdeasStore {
  const origin = (process.env.IDEAS_URL ?? process.env.CONCEPTS_URL)?.trim();
  const token = (process.env.IDEAS_TOKEN ?? process.env.CONCEPTS_TOKEN)?.trim();
  if (!origin || !token) throw new IdeasStoreUnconfiguredError();
  return { origin: origin.replace(/\/+$/, ''), token };
}

/**
 * A requested URL reduced to what is safe to show a reader: `origin` +
 * `pathname`, never the query string, which is what keeps a credential in a
 * configured URL out of an error message.
 */
function safeLabel(requested: string, fallbackPath: string): string {
  try {
    const url = new URL(requested);
    return `${url.origin}${url.pathname}`;
  } catch {
    return fallbackPath;
  }
}

/** Where the ledger lives, in a form a reader can be shown — this is `meta.file`'s value now. */
export function remoteIdeasStoreLabel(store: RemoteIdeasStore): string {
  return safeLabel(`${store.origin}/api/ideas`, '/api/ideas');
}

/**
 * One call to the ledger, with the token attached and every failure turned into
 * a {@link RemoteIdeasStoreError}.
 *
 * **A non-2xx answer throws rather than resolving to an empty result**: an empty
 * ledger and an unreachable one are indistinguishable to a caller, and the
 * caller here is about to decide whether an idea has been proposed before.
 */
async function call<T>(store: RemoteIdeasStore, path: string, init?: RequestInit): Promise<T> {
  const url = `${store.origin}${path}`;
  const label = safeLabel(url, path);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        authorization: `Bearer ${store.token}`,
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    throw new RemoteIdeasStoreError(`${label} (${(err as Error).message})`);
  }
  if (!response.ok) {
    // The Worker's own refusal is the useful half of a 400 — it is core's parse
    // message — so it is carried through rather than replaced.
    const detail = await response.text().catch(() => '');
    const reason = detail ? `: ${detail.slice(0, 500)}` : '';
    throw new RemoteIdeasStoreError(`${label} answered ${response.status}${reason}`);
  }
  return (await response.json()) as T;
}

/**
 * The whole ledger.
 *
 * Parsed through the same `parseIdeasStore` the file reader used, so a row this
 * version does not understand degrades identically wherever it is read from.
 */
export async function fetchRemoteIdeas(store: RemoteIdeasStore): Promise<IdeasStore> {
  return parseIdeasStore(await call<unknown>(store, '/api/ideas/export'));
}

export interface RemoteAddResult {
  added: string[];
  refused: string[];
  similar: Record<string, string[]>;
  similarAreas: Record<string, string[]>;
}

export interface RemoteWriteResult {
  updated: string[];
  unknown: string[];
}

export interface RemoteClaimResult {
  claimed: string[];
  refused: { slug: string; status: string; heldBy?: string; since?: string; pr?: string }[];
  unknown: string[];
}

function post<T>(store: RemoteIdeasStore, path: string, body: unknown): Promise<T> {
  return call<T>(store, path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Record proposals. **The dedupe check happens on the server**, against every
 * device's ideas and every status including `rejected` — which is the whole
 * reason the ledger moved, so it is deliberately not re-done here from a
 * corpus this process happens to hold.
 */
export function addRemoteIdeas(store: RemoteIdeasStore, ideas: unknown): Promise<RemoteAddResult> {
  return post<RemoteAddResult>(store, '/api/ideas', { ideas });
}

export function markRemoteIdeas(store: RemoteIdeasStore, marks: unknown): Promise<RemoteWriteResult> {
  return post<RemoteWriteResult>(store, '/api/ideas/mark', { marks });
}

export function fileRemoteIdeas(store: RemoteIdeasStore, filings: unknown): Promise<RemoteWriteResult> {
  return post<RemoteWriteResult>(store, '/api/ideas/file', { filings });
}

export function commentRemoteIdeas(store: RemoteIdeasStore, comments: unknown): Promise<RemoteWriteResult> {
  return post<RemoteWriteResult>(store, '/api/ideas/comment', { comments });
}

/**
 * Take ideas. The refusal in the body names whoever holds one — a live holder is
 * an answer, not a failed request, exactly as it was when this was a file.
 */
export function claimRemoteIdeas(store: RemoteIdeasStore, claims: unknown): Promise<RemoteClaimResult> {
  return post<RemoteClaimResult>(store, '/api/ideas/claim', { claims });
}
