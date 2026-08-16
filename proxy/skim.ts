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
 *   SKIM_CACHE        truthy (1|true|yes|on) to enable. Default off.
 *   SKIM_TTL_MS       entry lifetime in ms. Default 3600000 (1h).
 *   SKIM_MAX_ENTRIES  how many entries the directory may hold. Default 2000.
 *   SKIM_DIR          cache directory. Default <LOG_DIR>/../.skim-cache
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { RequestBody } from './wire.ts';

const ON = /^(1|true|yes|on)$/i.test(process.env.SKIM_CACHE ?? '');
const TTL_MS = Number(process.env.SKIM_TTL_MS ?? 3_600_000);

/** Decision 004 suggests "a few thousand"; the exact number is unratified. */
const DEFAULT_MAX_ENTRIES = 2_000;

const SSE_EXT = '.sse';
const META_EXT = '.meta.json';

/** `SKIM_MAX_ENTRIES`, read per call rather than at load. Junk or <=0 falls back. */
function envMaxEntries(): number {
  const raw = Number(process.env.SKIM_MAX_ENTRIES ?? DEFAULT_MAX_ENTRIES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_ENTRIES;
}

/** What a stored entry's `.meta.json` sidecar carries. */
export interface SkimMeta {
  statusCode?: number;
  /** Kept as upstream sent it — Node hands back an array for a repeated header. */
  contentType?: string | string[];
  inputTokens?: number;
  model?: string;
  storedAt?: number;
}

/** A cache hit: the metadata plus the raw SSE body to replay. */
export interface SkimHit {
  meta: SkimMeta;
  body: Buffer;
}

export const skimEnabled = (): boolean => ON;

/** Where entries live. Sibling of the logs dir unless SKIM_DIR overrides. */
export const cacheDir = (logDir: string): string => process.env.SKIM_DIR ?? path.join(logDir, '..', '.skim-cache');

/** The gate: streamed /v1/messages only (we store and replay raw SSE), and only when enabled. */
export function cacheable(reqPath: string, reqJson: RequestBody | null): boolean {
  if (!ON) return false;
  if (!reqPath.includes('/v1/messages')) return false;
  if (reqJson?.stream !== true) return false; // we can only replay a stream
  return true;
}

/** Cache key: exact hash of the request body (model is inside the body). */
export const keyFor = (rawBody: Buffer | string): string => crypto.createHash('sha256').update(rawBody).digest('hex');

/**
 * Mark an entry as just-used by moving its body's mtime to now — the LRU key
 * `evict` orders on. Best-effort: a failed touch must not turn a hit into a miss.
 */
function touch(dir: string, key: string): void {
  try {
    const now = new Date();
    fs.utimesSync(path.join(dir, `${key}${SSE_EXT}`), now, now);
  } catch {
    /* best-effort */
  }
}

/**
 * Look up a live entry. Returns { meta, body } or null on miss/stale/error.
 * Stale (older than TTL) is treated as a miss and left for later overwrite.
 * A hit touches the entry's mtime, which is the LRU key `evict` orders on.
 */
export function lookup(dir: string, key: string): SkimHit | null {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${key}${META_EXT}`), 'utf8')) as SkimMeta;
    if (Date.now() - (meta.storedAt ?? 0) > TTL_MS) return null;
    const body = fs.readFileSync(path.join(dir, `${key}${SSE_EXT}`));
    touch(dir, key);
    return { meta, body };
  } catch {
    return null;
  }
}

/** Remove both files of one entry. Returns whether anything was actually deleted. */
function unlinkEntry(dir: string, key: string): boolean {
  let removed = false;
  for (const ext of [SSE_EXT, META_EXT]) {
    try {
      fs.unlinkSync(path.join(dir, `${key}${ext}`));
      removed = true;
    } catch {
      /* already gone */
    }
  }
  return removed;
}

/** Overrides for `evict`; every field defaults to the env-derived value. */
export interface EvictOptions {
  ttlMs?: number;
  maxEntries?: number;
  /** A key never to remove — the entry `store` just wrote. */
  keep?: string;
}

/**
 * Bound the cache directory: one `readdir`, then drop a `.meta.json` whose body
 * is gone, drop anything past the TTL, and drop the oldest of whatever survives
 * until the count is within `maxEntries`. Write path only — the read path runs
 * on every request, this runs only on a miss. Returns how many entries went.
 *
 * Expiry is judged on mtime rather than the meta's `storedAt`, which is the
 * conservative side of the same TTL: mtime is set at write and only ever moves
 * forward, so it is always >= `storedAt`, and eviction can never delete
 * something `lookup` would still have served.
 *
 * Best-effort throughout — a failed `readdir`, `stat`, or `unlink` leaves the
 * file in place rather than disturbing the request that triggered it.
 */
export function evict(dir: string, options: EvictOptions = {}): number {
  const { ttlMs = TTL_MS, maxEntries = envMaxEntries(), keep } = options;
  let removed = 0;
  try {
    const names = fs.readdirSync(dir);
    const keys = new Set<string>();
    for (const name of names) {
      if (name.endsWith(SSE_EXT)) keys.add(name.slice(0, -SSE_EXT.length));
    }

    for (const name of names) {
      if (!name.endsWith(META_EXT)) continue;
      const key = name.slice(0, -META_EXT.length);
      if (keys.has(key) || key === keep) continue;
      if (unlinkEntry(dir, key)) removed += 1;
    }

    const now = Date.now();
    const live: { key: string; mtimeMs: number }[] = [];
    for (const key of keys) {
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(path.join(dir, `${key}${SSE_EXT}`)).mtimeMs;
      } catch {
        continue; // vanished under us
      }
      if (key !== keep && Number.isFinite(ttlMs) && now - mtimeMs > ttlMs) {
        if (unlinkEntry(dir, key)) removed += 1;
        continue;
      }
      live.push({ key, mtimeMs });
    }

    if (live.length > maxEntries) {
      live.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const entry of live.slice(0, live.length - maxEntries)) {
        if (entry.key === keep) continue;
        if (unlinkEntry(dir, entry.key)) removed += 1;
      }
    }
  } catch {
    /* best-effort */
  }
  return removed;
}

/** What the proxy hands over for storage after a successful upstream call. */
export interface SkimStoreInput {
  statusCode?: number;
  contentType?: string | string[];
  rawResponse: Buffer;
  inputTokens?: number | null;
  model?: unknown;
}

/**
 * Persist a response, then bound the directory. Best-effort: a failed write
 * must never break the proxy, and neither may a failed eviction.
 */
export function store(
  dir: string,
  key: string,
  { statusCode, contentType, rawResponse, inputTokens, model }: SkimStoreInput,
): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${key}${SSE_EXT}`), rawResponse);
    fs.writeFileSync(
      path.join(dir, `${key}${META_EXT}`),
      JSON.stringify(
        {
          statusCode: statusCode ?? 200,
          contentType: contentType ?? 'text/event-stream',
          inputTokens: inputTokens ?? 0,
          model: model ?? 'unknown',
          storedAt: Date.now(),
        },
        null,
        2,
      ),
    );
  } catch {
    /* best-effort */
  }
  evict(dir, { keep: key });
}
