/**
 * skim — an opt-in, app-layer response cache for the proxy.
 *
 * This is NOT Anthropic's prefix cache (that caches transformer KV-state and
 * lives on their GPUs). The skim caches the model's *output*: on a byte-exact
 * repeat of a streamed /v1/messages request, the proxy replays the stored SSE
 * reply and makes **zero** call to Anthropic — saving the entire request.
 *
 * Rough prototype (wayfinder ticket 001): byte-exact keying only. Exact input
 * means replaying the same output is the safe floor; semantic matching, a
 * dependency-aware key, and correctness guardrails are later tickets. Off by
 * default so the proxy stays a transparent pass-through.
 *
 * Env:
 *   SKIM_CACHE   truthy (1|true|yes|on) to enable. Default off.
 *   SKIM_TTL_MS  entry lifetime in ms. Default 3600000 (1h).
 *   SKIM_DIR     cache directory. Default <LOG_DIR>/../.skim-cache
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ON = /^(1|true|yes|on)$/i.test(process.env.SKIM_CACHE ?? "");
const TTL_MS = Number(process.env.SKIM_TTL_MS ?? 3_600_000);

export const skimEnabled = () => ON;

/** Where entries live. Sibling of the logs dir unless SKIM_DIR overrides. */
export const cacheDir = (logDir) =>
  process.env.SKIM_DIR ?? path.join(logDir, "..", ".skim-cache");

/** The gate: streamed /v1/messages only (we store and replay raw SSE), and only when enabled. */
export function cacheable(reqPath, reqJson) {
  if (!ON) return false;
  if (!reqPath.includes("/v1/messages")) return false;
  if (reqJson?.stream !== true) return false; // we can only replay a stream
  return true;
}

/** Cache key: exact hash of the request body (model is inside the body). */
export const keyFor = (rawBody) =>
  crypto.createHash("sha256").update(rawBody).digest("hex");

/**
 * Look up a live entry. Returns { meta, body } or null on miss/stale/error.
 * Stale (older than TTL) is treated as a miss and left for later overwrite.
 */
export function lookup(dir, key) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}.meta.json`), "utf8"));
    if (Date.now() - (meta.storedAt ?? 0) > TTL_MS) return null;
    const body = fs.readFileSync(path.join(dir, `${key}.sse`));
    return { meta, body };
  } catch {
    return null;
  }
}

/** Persist a response. Best-effort: a failed write must never break the proxy. */
export function store(dir, key, { statusCode, contentType, rawResponse, inputTokens, model }) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}.sse`), rawResponse);
    fs.writeFileSync(
      path.join(dir, `${key}.meta.json`),
      JSON.stringify(
        {
          statusCode: statusCode ?? 200,
          contentType: contentType ?? "text/event-stream",
          inputTokens: inputTokens ?? 0,
          model: model ?? "unknown",
          storedAt: Date.now(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort */
  }
}
