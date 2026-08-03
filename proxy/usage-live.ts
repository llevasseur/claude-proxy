import fs from 'node:fs';
import path from 'node:path';
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
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Newest forwarded credentials, in memory only. */
let auth: { authorization: string; beta: string | undefined } | null = null;

/**
 * Remember the OAuth bearer off a forwarded request. API keys are ignored: the
 * endpoint is OAuth-only, and an `x-api-key` account has real headers instead.
 */
export function noteAuth(headers: HeaderBag | undefined | null): void {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || !/^Bearer\s+\S/i.test(value)) return;
  const beta = headers?.['anthropic-beta'];
  auth = { authorization: value, beta: Array.isArray(beta) ? beta.join(', ') : beta };
}

/** Test seam. */
export function resetAuth(): void {
  auth = null;
}

export function hasAuth(): boolean {
  return auth !== null;
}

async function fetchUsage(fetchImpl: FetchLike): Promise<unknown> {
  if (!auth) return null;
  const headers: Record<string, string> = { authorization: auth.authorization, 'content-type': 'application/json' };
  if (auth.beta) headers['anthropic-beta'] = auth.beta;
  const res = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * Poll once and write `<logDir>/usage-live.json` on success. A failed poll leaves
 * the previous file alone — a stale reading still carries a usable reset instant.
 */
export async function pollOnce(logDir: string, fetchImpl: FetchLike = globalThis.fetch): Promise<boolean> {
  let payload: unknown;
  try {
    payload = await fetchUsage(fetchImpl);
  } catch (err) {
    // Never interpolate the error's request context — it can carry the token.
    console.warn(`[agent-proxy] usage poll failed: ${errorMessage(err)}`);
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
  } catch (err) {
    console.warn(`[agent-proxy] usage write failed: ${errorMessage(err)}`);
    return false;
  }
}

/** A caught value is `unknown`; this is the message it would have shown. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : ((err as { message?: string } | null)?.message ?? 'unknown error');
}

/** Poll every `intervalMs` for as long as the proxy runs. Unref'd, so it never holds the process open. */
export function startUsagePolling(
  logDir: string,
  { intervalMs = 60_000, fetchImpl }: { intervalMs?: number; fetchImpl?: FetchLike } = {},
): () => void {
  const tick = () => {
    void pollOnce(logDir, fetchImpl ?? globalThis.fetch);
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
