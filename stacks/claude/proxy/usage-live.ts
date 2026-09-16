import fs from 'node:fs';
import path from 'node:path';
import type { JsonValue } from './json.ts';
import type { HeaderBag } from './wire.ts';

/**
 * Anthropic's own usage figures, polled and written next to the logs.
 *
 * The endpoint needs the user's OAuth token, which this proxy already forwards, so
 * the poll lives here and only the resulting numbers reach disk. The token is never
 * written, logged, or exported.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** File the server reads. Writing it also wakes the existing log-dir SSE watcher. */
export const LIVE_USAGE_FILE = 'usage-live.json';

/**
 * Just enough of `fetch` to poll with — so a test can hand over a stub without
 * building a whole `Response`. `globalThis.fetch` satisfies it.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<JsonValue> }>;

/** `globalThis.fetch` as a {@link FetchLike}, whose `json()` promises a `JsonValue`. */
const nativeFetch: FetchLike = async (url, init) => {
  const res = await globalThis.fetch(url, init);
  // SAFETY: `res.json()` is `JSON.parse` of the response text, so every value it can
  // settle to is a `JsonValue`; it is typed `unknown` only because a body may be any.
  return { ok: res.ok, status: res.status, json: () => res.json() as Promise<JsonValue> };
};

/** One forwarded credential, as the poll and a keep-alive ping both need it. */
interface Credentials {
  authorization: string;
  beta: string | undefined;
}

/** Newest forwarded credentials, in memory only. What the usage poll authenticates with. */
let auth: Credentials | null = null;

/**
 * The newest bearer seen for each `account_uuid`, in memory only.
 *
 * A keep-alive ping reads this rather than the credential captured with its own entry.
 * A warm entry exists precisely because its session went quiet, so the bearer stored
 * alongside it ages with nothing to refresh it — while another session live on the same
 * account keeps this one current. Measured on one archived day: 52 distinct sessions on
 * a single account, and never a gap above 29.2 minutes against a 50-minute ping
 * interval. See ADR 0076.
 *
 * Never written, logged, or exported as a value — only {@link bearerForAccount} reads
 * it, and a proxy restart clears it.
 */
const byAccount = new Map<string, Credentials>();

/**
 * Remember the OAuth bearer off a forwarded request. API keys are ignored: the
 * endpoint is OAuth-only, and an `x-api-key` account has real headers instead.
 *
 * `account` is `metadata.user_id.account_uuid` when the caller has it, and widens this
 * from one global bearer to one per account without changing what the poll sees: the
 * global is still set on every call, so a caller that passes no account behaves exactly
 * as it did before the account-keyed store existed.
 */
export function noteAuth(headers: HeaderBag | undefined | null, account: string | null = null): void {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !/^Bearer\s+\S/i.test(value)) return;
  const beta = headers?.['anthropic-beta'];
  const credentials: Credentials = { authorization: value, beta: Array.isArray(beta) ? beta.join(', ') : beta };
  auth = credentials;
  if (account) byAccount.set(account, credentials);
}

/** Test seam. */
export function resetAuth(): void {
  auth = null;
  byAccount.clear();
}

export function hasAuth(): boolean {
  return auth !== null;
}

/**
 * The newest bearer held for one account, or null when none is held for it.
 *
 * **There is no cross-account fallback, and an entry with no account of its own gets
 * nothing.** Borrowing a different account's token is the objection ADR 0076 scopes
 * against, so falling back to the global {@link auth} here would reintroduce exactly
 * what the scoping exists to prevent. An entry that gets null stops and reports
 * `no-credential` rather than pinging with a token that was never its own.
 */
export function bearerForAccount(account: string | null): string | null {
  if (!account) return null;
  return byAccount.get(account)?.authorization ?? null;
}

async function fetchUsage(fetchImpl: FetchLike): Promise<JsonValue | null> {
  if (!auth) return null;
  const headers: Record<string, string> = {};
  headers.authorization = auth.authorization;
  headers['content-type'] = 'application/json';
  if (auth.beta) headers['anthropic-beta'] = auth.beta;
  const res = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * Poll once and write `<logDir>/usage-live.json` on success. A failed poll leaves
 * the previous file alone — a stale reading still carries a usable reset instant.
 */
export async function pollOnce(logDir: string, fetchImpl: FetchLike = nativeFetch): Promise<boolean> {
  let payload: JsonValue | null = null;
  try {
    payload = await fetchUsage(fetchImpl);
  } catch (cause) {
    // Never interpolate the error's request context — it can carry the token.
    console.warn(`[agent-proxy] usage poll failed: ${errorMessage(cause)}`);
    return false;
  }
  if (payload == null) return false;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    const dest = path.join(logDir, LIVE_USAGE_FILE);
    const tmp = `${dest}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt: new Date().toISOString(), payload }));
    fs.renameSync(tmp, dest);
    return true;
  } catch (cause) {
    console.warn(`[agent-proxy] usage write failed: ${errorMessage(cause)}`);
    return false;
  }
}

/** A caught value is `unknown`; this is the message it would have shown. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  // SAFETY: claims only that `message` may be there — `?.` covers a `null` throw and
  // the fallback covers a value carrying no message.
  return (cause as { message?: string } | null)?.message ?? 'unknown error';
}

/** Poll every `intervalMs` for as long as the proxy runs. Unref'd, so it never holds the process open. */
export function startUsagePolling(
  logDir: string,
  { intervalMs = 60_000, fetchImpl }: { intervalMs?: number; fetchImpl?: FetchLike } = {},
): () => void {
  const tick = () => {
    void pollOnce(logDir, fetchImpl ?? nativeFetch);
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
