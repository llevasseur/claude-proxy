/**
 * cache-breakpoint — put back the message-level `cache_control` Claude Code
 * intermittently drops, so a turn stops re-billing its whole transcript as fresh
 * input.
 *
 * **The defect.** A healthy `/v1/messages` request from the CLI carries three
 * `{"type":"ephemeral","ttl":"1h"}` breakpoints: two on `system`, and one on the
 * final content block of the last message. Intermittently a turn ships the two
 * system ones and **none on any message**. The API can then only read the
 * system+tools prefix, `cache_creation_input_tokens` comes back 0, and the entire
 * message history bills as `input_tokens`. The next turn reads the same prefix it
 * always could, so the omission forfeits both the read and the write and buys
 * nothing. Captured cold requests are byte-identical to their healthy neighbours
 * once `cache_control` is stripped — same tools, same system blocks, same
 * sampling fields, same session, every message hash matching position-for-position
 * — so this is the client dropping a breakpoint, not the prefix moving.
 *
 * **Self-retiring by construction.** The first gate is "no `cache_control`
 * anywhere in `messages`". When the CLI starts always shipping the breakpoint the
 * branch becomes unreachable and this module is a no-op — deliberately, instead of
 * a version check or a date-based expiry that would need maintaining. The audit
 * sidecar records whether injection happened on every request, that field becomes
 * a nullable column in the substrate, and the day's total surfaces as
 * `UsageDigest.cacheBreakpointInjections`. **That count is the retirement
 * trigger: once it has sat at zero for a week after a CLI upgrade, delete this
 * module and its three call sites.** The code reports its own obsolescence so
 * nobody has to track Claude Code releases to know when it is safe to go.
 *
 * **Known consequence, accepted.** Injecting changes the bytes
 * `skim.keyFor(forwardBody)` hashes, so an affected request gets a different skim
 * key than it would have and takes a one-time miss. The skim is an exact-repeat
 * cache and off by default; a one-time miss is cheaper than the cold call.
 *
 * Fails open throughout: an optimization must never break or drop a request.
 *
 * Zero runtime dependencies — Node built-ins only.
 */

import type { ContentBlock, RequestBody, WireMessage } from './wire.ts';

/**
 * The kill switch, read per call rather than at module load so a test can flip it.
 * `PROXY_CACHE_BREAKPOINT=off` disables injection; anything else leaves it on.
 */
function killed(): boolean {
  return /^(off|0|false|no)$/i.test(process.env.PROXY_CACHE_BREAKPOINT ?? '');
}

/**
 * How deep a transcript has to be before a write pays for itself. A cache write
 * bills at 1.25–2x fresh input, so injecting on a short prompt loses money; the
 * observed cold calls carry 100 KB–800 KB of messages. Either measure qualifies:
 * bytes is what actually sets the write cost, and a long turn count catches a
 * transcript of many small messages.
 */
const MIN_MESSAGE_BYTES = 100_000;
const MIN_MESSAGES = 40;

/** How many sessions the warm-prefix ledger remembers; oldest sighting evicted first. */
const WARM_LIMIT = 500;

/**
 * Sessions observed reading more from cache than their own system+tools prefix —
 * proof the *message* prefix is cached upstream, not just the system blocks.
 *
 * In memory only, and keyed by session rather than by prefix hash: it answers one
 * question ("would a read actually recover this write?") and a wrong answer costs
 * a cache write, not correctness. A proxy restart empties it, so the first cold
 * turn of each session after a restart is left alone — the conservative direction.
 */
const warmSessions = new Map<string, number>();

/**
 * Note what a reply actually read from cache. `prefixTokens` is the estimated
 * system+tools size; a read above it means the message history was cached too,
 * which is the only evidence that injecting a breakpoint has a read to recover it.
 */
export function noteCacheRead(
  sessionKey: string | null | undefined,
  cacheReadTokens: number | null | undefined,
  prefixTokens: number | null | undefined,
): void {
  try {
    if (!sessionKey) return;
    const read = cacheReadTokens ?? 0;
    const prefix = prefixTokens ?? 0;
    if (prefix <= 0 || read <= prefix) return;
    warmSessions.set(sessionKey, Date.now());
    while (warmSessions.size > WARM_LIMIT) {
      const oldest = warmSessions.keys().next().value;
      if (oldest === undefined) break;
      warmSessions.delete(oldest);
    }
  } catch {
    /* best-effort */
  }
}

/** Whether this session has ever been seen reading past its own system prefix. */
export function hasWarmPrefix(sessionKey: string | null | undefined): boolean {
  return !!sessionKey && warmSessions.has(sessionKey);
}

/** Test seam: forget every observed warm prefix. */
export function _resetWarmPrefixes(): void {
  warmSessions.clear();
}

/** A block carries a breakpoint when `cache_control` is present and non-null. */
function hasCacheControl(block: unknown): boolean {
  return !!block && typeof block === 'object' && (block as ContentBlock).cache_control != null;
}

/**
 * Breakpoints on one message, counted through nested `tool_result` content as
 * well as the top level. Nesting is not where the API takes a breakpoint, but
 * counting it keeps every ambiguous body on the no-op side of gate 1.
 */
function messageBreakpoints(msg: WireMessage | undefined | null): number {
  const content = msg?.content;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const block of content as ContentBlock[]) {
    if (hasCacheControl(block)) n += 1;
    const inner = block?.content;
    if (Array.isArray(inner)) {
      for (const nested of inner) {
        if (hasCacheControl(nested)) n += 1;
      }
    }
  }
  return n;
}

/** Breakpoints across every message. */
function transcriptBreakpoints(messages: WireMessage[]): number {
  let n = 0;
  for (const m of messages) n += messageBreakpoints(m);
  return n;
}

/**
 * The `cache_control` of the last `system` block that carries one, cloned. Cloned
 * rather than rebuilt from a hardcoded `{type, ttl}` so a client-side TTL change —
 * or a field this proxy has never seen — carries through untouched.
 */
function systemCacheControl(system: unknown): { value: Record<string, unknown>; count: number } | null {
  if (!Array.isArray(system)) return null;
  let found: Record<string, unknown> | null = null;
  let count = 0;
  for (const block of system as ContentBlock[]) {
    if (!hasCacheControl(block)) continue;
    count += 1;
    const cc = block.cache_control;
    if (cc && typeof cc === 'object') found = { ...(cc as Record<string, unknown>) };
  }
  return found ? { value: found, count } : null;
}

/** How many breakpoints the API is willing to take on one request. */
const BREAKPOINT_CAP = 4;

export interface EnsureBreakpointOptions {
  /** The session this request belongs to — the key the warm-prefix ledger uses. */
  sessionKey?: string | null;
  /** Overrides the `PROXY_CACHE_BREAKPOINT` kill switch. Test seam. */
  enabled?: boolean;
  /** Overrides the depth gates. Test seam. */
  minBytes?: number;
  minMessages?: number;
}

/**
 * Put a breakpoint back on the last content block of the last message — where a
 * healthy turn puts it — when every gate below holds. Returns the original object
 * (same reference) and `injected: false` whenever any gate fails, so a request
 * nothing was done to is forwarded byte-for-byte.
 *
 * The gates are applied below in the order they are cheapest to fail.
 */
export function ensureMessageBreakpoint(
  reqJson: RequestBody | null,
  opts: EnsureBreakpointOptions = {},
): { reqJson: RequestBody | null; injected: boolean } {
  const miss = { reqJson, injected: false };
  try {
    if (!(opts.enabled ?? !killed())) return miss;

    const messages = reqJson?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return miss;
    const turns = messages as WireMessage[];

    // Gate 1 — the client already asked for a message breakpoint. Nothing to fix,
    // and once the CLI always does this, this module never acts again.
    if (transcriptBreakpoints(turns) > 0) return miss;

    // Gate 2 — the client wants caching, and tells us on what terms.
    const system = systemCacheControl(reqJson?.system);
    if (!system) return miss;

    // Gate 3 — the API takes four breakpoints; a fifth is an error, not a saving.
    if (system.count >= BREAKPOINT_CAP) return miss;

    // Gate 4 — a write bills above fresh input, so only a deep transcript pays.
    const messageBytes = Buffer.byteLength(JSON.stringify(messages));
    if (messageBytes < (opts.minBytes ?? MIN_MESSAGE_BYTES) && turns.length < (opts.minMessages ?? MIN_MESSAGES)) {
      return miss;
    }

    // Gate 5 — without a warm prefix this converts full-price fresh input into a
    // 2x write with no read to recover it.
    if (!hasWarmPrefix(opts.sessionKey)) return miss;

    // The breakpoint goes on the last content block of the last message. A last
    // message whose content is a bare string has no block to carry one, and
    // rewriting it into a block array would change more than the cache hint.
    const last = turns[turns.length - 1];
    const content = last?.content;
    if (!last || !Array.isArray(content) || content.length === 0) return miss;
    const blocks = content as ContentBlock[];
    const lastBlock = blocks[blocks.length - 1];
    if (!lastBlock || typeof lastBlock !== 'object') return miss;

    const nextBlocks = blocks.slice(0, -1).concat({ ...lastBlock, cache_control: system.value });
    const nextMessages = turns.slice(0, -1).concat({ ...last, content: nextBlocks });
    return { reqJson: { ...reqJson, messages: nextMessages }, injected: true };
  } catch {
    // Fail open: an optimization never breaks or drops a request.
    return miss;
  }
}
