import fs from "node:fs";
import path from "node:path";

/**
 * Anthropic's own usage figures, polled and written next to the logs.
 *
 * The endpoint needs the user's OAuth token, which this proxy already forwards, so
 * the poll lives here and only the resulting numbers reach disk. The token is never
 * written, logged, or exported.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** File the server reads. Writing it also wakes the existing log-dir SSE watcher. */
export const LIVE_USAGE_FILE = "usage-live.json";

/** Newest forwarded credentials, in memory only. */
let auth = null;

/**
 * Remember the OAuth bearer off a forwarded request. API keys are ignored: the
 * endpoint is OAuth-only, and an `x-api-key` account has real headers instead.
 */
export function noteAuth(headers) {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || !/^Bearer\s+\S/i.test(value)) return;
  const beta = headers["anthropic-beta"];
  auth = { authorization: value, beta: Array.isArray(beta) ? beta.join(", ") : beta };
}

/** Test seam. */
export function resetAuth() {
  auth = null;
}

export function hasAuth() {
  return auth !== null;
}

async function fetchUsage(fetchImpl) {
  if (!auth) return null;
  const headers = { authorization: auth.authorization, "content-type": "application/json" };
  if (auth.beta) headers["anthropic-beta"] = auth.beta;
  const res = await fetchImpl(USAGE_URL, { headers, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/**
 * Poll once and write `<logDir>/usage-live.json` on success. A failed poll leaves
 * the previous file alone — a stale reading still carries a usable reset instant.
 */
export async function pollOnce(logDir, fetchImpl = globalThis.fetch) {
  let payload;
  try {
    payload = await fetchUsage(fetchImpl);
  } catch (err) {
    // Never interpolate the error's request context — it can carry the token.
    console.warn(`[agent-proxy] usage poll failed: ${err?.message ?? "unknown error"}`);
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
    console.warn(`[agent-proxy] usage write failed: ${err?.message ?? "unknown error"}`);
    return false;
  }
}

/** Poll every `intervalMs` for as long as the proxy runs. Unref'd, so it never holds the process open. */
export function startUsagePolling(logDir, { intervalMs = 60_000, fetchImpl } = {}) {
  const tick = () => {
    void pollOnce(logDir, fetchImpl ?? globalThis.fetch);
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
