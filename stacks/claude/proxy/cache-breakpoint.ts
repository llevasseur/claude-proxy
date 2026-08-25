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
 * a version check or a date-based expiry that would need maintaining.
 *
 * **The retirement trigger is the observation count, not the injection count.**
 * Every call reports two separate facts: whether the defect was *observed* (gates
 * 1–3: the client shipped no message breakpoint, asked for caching, and has room
 * for another key) and whether an injection actually *happened*. Both reach the
 * audit sidecar on every request, become nullable columns in the substrate, and
 * surface as `UsageDigest.cacheBreakpointObservations` beside
 * `cacheBreakpointInjections`. Injections alone cannot carry the trigger: the later
 * gates decline most occurrences, so a week of zero injections is equally consistent
 * with "the CLI was fixed" (safe to retire) and "it still drops the breakpoint and a
 * gate said no" (must not retire) — the first ~18 minutes live recorded 152
 * requests, 0 injections and 2 occurrences, entirely the second case. **Retire on a
 * week of zero *observations* after a CLI upgrade: delete this module and its three
 * call sites.** `cacheBreakpointDeclines` names the gate that turned each observed
 * occurrence away, so a zero produced by an over-strict gate reads as one.
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

import { asList, asRecord, type JsonObject, type JsonValue } from './json.ts';
import { asArrayOf, type RequestBody, type WireMessage } from './wire.ts';

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
 * Bytes per token across a request's system+tools prefix, measured rather than
 * assumed.
 *
 * Measured across 530 cold-start requests in the log window — `cacheRead` 0 and
 * `input` under 50, so `totalBytes / cacheCreation` is the ratio outright — out of
 * 50,122 logged requests: median 2.78 bytes per token, p10 2.71, p90 2.87, densest
 * 2.544. The ratio is flat across the model line (opus-4-8 2.69, sonnet-5 2.80,
 * fable-5 2.83, opus-5 2.85). The `bytes / 4` display estimate that preceded this
 * constant understated the prefix by ~44% and marked a session warm on a read of
 * nothing but its own system blocks, turning gate 5 into "has this session ever had
 * a cache hit".
 *
 * **The prefix is not measurably denser than the request it opens.** An earlier
 * reading of 29 requests inferred that dense JSON tool schemas must tokenize worse,
 * resting on one directly observed prefix-only read at 2.52. The corpus holds no
 * cold start whose messages are under 5% of the body, so the closest available
 * sample is the 92 whose messages are under 20%: those run a mean of 2.77 and a
 * densest of 2.635 — the corpus figure, not below it.
 *
 * The denominator sits below the densest figure observed rather than at the mean,
 * because the directions are not symmetric: understating the prefix marks a cold
 * session warm and buys a 2x cache write with no read to recover it, while
 * overstating it only declines an injection that might have paid. Gate 5 rounds
 * toward declining. 2.5 clears the densest prefix-dominated request by 5.4% and the
 * densest request of any shape by 1.8% — thin, but on the declining side of both,
 * which is why the figure is unchanged.
 */
const PREFIX_BYTES_PER_TOKEN = 2.5;

/**
 * The system+tools prefix in tokens — the figure `noteCacheRead` compares a cache
 * read against. Separate from the proxy's `estTokens`, which reads the same corpus
 * but takes its median (2.78) where this takes a floor; a threshold inside a cost
 * decision rounds toward declining, a display estimate aims at the middle.
 */
export function estPrefixTokens(bytes: number): number {
  return Math.round(bytes / PREFIX_BYTES_PER_TOKEN);
}

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
 * Note what a reply actually read from cache. `prefixTokens` is the system+tools
 * size in tokens, as `estPrefixTokens` measures it; a read above it means the
 * message history was cached too, which is the only evidence that injecting a
 * breakpoint has a read to recover it.
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
function hasCacheControl(block: JsonValue | undefined): boolean {
  return asRecord(block)?.cache_control != null;
}

/**
 * Breakpoints on one message, counted through nested `tool_result` content as
 * well as the top level. Nesting is not where the API takes a breakpoint, but
 * counting it keeps every ambiguous body on the no-op side of gate 1.
 */
function messageBreakpoints(msg: WireMessage | undefined | null): number {
  const content = asList(msg?.content);
  if (content === null) return 0;
  let n = 0;
  for (const block of content) {
    if (hasCacheControl(block)) n += 1;
    const inner = asList(asRecord(block)?.content);
    if (inner !== null) {
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
function systemCacheControl(system: JsonValue | undefined): { value: JsonObject; count: number } | null {
  const blocks = asList(system);
  if (blocks === null) return null;
  let found: JsonObject | null = null;
  let count = 0;
  for (const block of blocks) {
    if (!hasCacheControl(block)) continue;
    count += 1;
    const cc = asRecord(asRecord(block)?.cache_control);
    if (cc !== null) found = { ...cc };
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
 * Which gate turned away an already-observed occurrence. `depth` is gate 4 (the
 * transcript is too shallow for a write to pay), `cold-prefix` is gate 5 (nothing
 * proves the message prefix is cached upstream), `no-content-block` the structural
 * check after it — a last message whose content is a bare string carries no hint.
 */
export type DeclinedGate = 'depth' | 'cold-prefix' | 'no-content-block';

export interface EnsureBreakpointResult {
  reqJson: RequestBody | null;
  injected: boolean;
  /**
   * Gates 1–3 passed: the CLI shipped no message breakpoint while asking for caching
   * and leaving room under the four-breakpoint cap. True on every occurrence,
   * injected or declined, which is what makes a zero readable. False when the kill
   * switch is set or the body was never inspected — nothing was seen either way.
   */
  observed: boolean;
  /** The gate that declined an observed occurrence; null when none did. */
  declinedBy: DeclinedGate | null;
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
): EnsureBreakpointResult {
  /** No injection and nothing observed — every return before gate 3 has passed. */
  const miss: EnsureBreakpointResult = { reqJson, injected: false, observed: false, declinedBy: null };
  /** The defect was observed here, and this gate declined the injection anyway. */
  const declined = (gate: DeclinedGate): EnsureBreakpointResult => ({
    reqJson,
    injected: false,
    observed: true,
    declinedBy: gate,
  });
  try {
    if (!(opts.enabled ?? !killed())) return miss;

    const turns = asArrayOf<WireMessage>(reqJson?.messages);
    if (turns.length === 0) return miss;

    // Gate 1 — the client already asked for a message breakpoint. Nothing to fix,
    // and once the CLI always does this, this module never acts again.
    if (transcriptBreakpoints(turns) > 0) return miss;

    // Gate 2 — the client wants caching, and tells us on what terms.
    const system = systemCacheControl(reqJson?.system);
    if (!system) return miss;

    // Gate 3 — the API takes four breakpoints; a fifth is an error, not a saving.
    if (system.count >= BREAKPOINT_CAP) return miss;

    // Past gate 3 the defect is confirmed, so every return below reports it observed.

    // Gate 4 — a write bills above fresh input, so only a deep transcript pays.
    const messageBytes = Buffer.byteLength(JSON.stringify(turns));
    if (messageBytes < (opts.minBytes ?? MIN_MESSAGE_BYTES) && turns.length < (opts.minMessages ?? MIN_MESSAGES)) {
      return declined('depth');
    }

    // Gate 5 — without a warm prefix this converts full-price fresh input into a
    // 2x write with no read to recover it.
    if (!hasWarmPrefix(opts.sessionKey)) return declined('cold-prefix');

    // The breakpoint goes on the last content block of the last message. A last
    // message whose content is a bare string has no block to carry one, and
    // rewriting it into a block array would change more than the cache hint.
    const last = turns[turns.length - 1];
    const content = asList(last?.content);
    if (!last || content === null || content.length === 0) return declined('no-content-block');
    const lastBlock = asRecord(content[content.length - 1]);
    if (lastBlock === null) return declined('no-content-block');

    const nextBlocks = content.slice(0, -1).concat({ ...lastBlock, cache_control: system.value });
    const nextMessages = turns.slice(0, -1).concat({ ...last, content: nextBlocks });
    return { reqJson: { ...reqJson, messages: nextMessages }, injected: true, observed: true, declinedBy: null };
  } catch {
    // Fail open: an optimization never breaks or drops a request. A throw reports no
    // observation rather than guessing which side of gate 3 it happened on.
    return miss;
  }
}
