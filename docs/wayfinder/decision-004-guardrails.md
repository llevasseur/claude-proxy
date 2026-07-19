---
label: wayfinder:decision
ticket: "004"
map: map-proxy-skim
status: proposed
---

# Decision 004 — Correctness guardrails for serving cached replies

> **Status: proposed — needs human ratification (charted AFK).**
> This document was drafted without a live human in the loop. Every answer below
> is a *recommendation* grounded in the current prototype code
> (`proxy/skim.mjs` + `proxy/proxy.mjs` as of ticket 001), not a settled
> decision. The map's own note stands: the grilling answers were charted from a
> prior conversation and must be revisited with the human before they are treated
> as final. Do not build irreversible behavior on this doc until it is ratified.

## What the prototype actually does today (the thing we are reacting to)

Read from `proxy/skim.mjs` and the skim branch of `proxy/proxy.mjs`:

- **Off by default.** `SKIM_CACHE` must be truthy (`1|true|yes|on`) or
  `cacheable()` returns `false` for everything. The proxy is a transparent
  pass-through unless explicitly opted in.
- **Narrow gate.** `cacheable()` only admits `POST /v1/messages` with
  `stream === true`. `count_tokens` is separately excluded in `proxy.mjs`
  (`isTokenCount`). Non-streaming `/v1/messages` is never cached because the
  replay path only knows how to replay raw SSE.
- **Byte-exact key.** `keyFor()` is `sha256(rawBody)` — the entire request body,
  model included. Any one-byte difference (a new timestamp, a reordered message)
  is a different key and thus a miss. This is the safe floor the map describes.
- **Store is guarded to 200 only.** In the miss path, `skim.store()` is called
  **only** when `statusCode === 200`. Non-200 upstream responses are never
  written.
- **TTL, no size bound.** `SKIM_TTL_MS` (default 1h) is enforced on *read*:
  `lookup()` returns `null` for an entry older than the TTL. There is **no** max
  entry count, **no** eviction, and stale files are never deleted — they are only
  overwritten if the identical key recurs. A stale entry just falls through to a
  live upstream call.
- **Every request is audited.** The `.audit.json` sidecar always carries a `skim`
  block (`enabled`, `servedFromCache`, `savedInputTokens`, `cacheKey`), and a hit
  prints `SKIM HIT <key8> · saved ~N input tok` to the console.

Three real gaps fall straight out of that reading, and the recommendations below
target them:

1. **Partial streams can be stored as if whole.** The miss path buffers
   `respChunks` and stores on `statusCode === 200`. If the upstream stream is cut
   off after headers (client/network abort, upstream mid-stream error), the status
   line was already `200` but the body is a truncated SSE with no terminal
   `message_delta`/`message_stop`. Today that truncated reply would be cached and
   later replayed as if complete.
2. **Secrets / `tool_result`s are cached indistinguishably from anything else.**
   The key and the stored `.sse` are opaque bytes; a request whose messages carry
   an API key, a short-lived token, or a `tool_result` snapshot of now-changed
   state is cached like any other and can be replayed after that state moves on.
3. **The cache directory grows without bound.** No count cap, no eviction, no
   cleanup of expired files.

---

## Q1 — Default posture: opt-in forever, or on-by-default once trusted?

**Recommendation: opt-in forever for the skim as a whole; earn a narrower
"on-by-default" only for a provably-safe *slice*, and only after the guardrails
below ship and the ticket-005 dashboard shows a real hit-rate and a zero
wrong-serve record.**

Rationale grounded in the code:

- The prototype is deliberately `SKIM_CACHE`-gated and the map states the skim
  "defaults **off** and never changes the bytes Claude Code sees on a miss." That
  posture is the product's safety story, not a rough-prototype limitation, so the
  default should not silently flip.
- The byte-exact key means the *only* thing an "on-by-default" would ever serve is
  a reply to an identical request — but "identical request, changed world" is
  exactly the poison case (Q4). Until staleness is bounded and the dangerous
  content classes (Q3) are excluded, on-by-default converts a user's inaction into
  consent to a wrong answer.
- A reasonable graduation path, if the human wants one later: keep `SKIM_CACHE`
  opt-in for the general cache, but allow a future `SKIM_DEFAULT_SAFE=1` mode that
  is on by default and restricted to the provably-idempotent slice (short TTL,
  content-class exclusions enforced, dashboard-visible). That is a *new* decision
  to make after data, not something to assume now.

Ratification needed on: whether "trusted once measured" is even a goal, or the
skim stays a power-user opt-in indefinitely.

## Q2 — Kill switch & observability: how does a user notice a wrong served reply, and undo it fast?

**Recommendation: three layers — a global off switch that already exists, a
per-entry undo, and a dashboard signal (ticket 005) that makes a served hit
visible in the first place.**

1. **Global kill switch (exists, keep it first-class).** `SKIM_CACHE` unset or
   `0` disables all serving immediately; because the gate is checked per request,
   the next request after a restart is a clean pass-through. This is the "stop the
   bleeding" control and should stay the documented emergency stop. Recommend
   adding a companion `SKIM_BYPASS=1` that still *records* would-be hits in the
   sidecar but always calls upstream, so a user can A/B a suspicious reply without
   losing the cache.
2. **Per-entry undo (small gap to close).** Today undo means deleting
   `<key>.sse` + `<key>.meta.json` by hand from `SKIM_DIR`. That is serviceable
   but unguided. Recommend: (a) the `SKIM HIT` log line and the `.audit.json`
   `skim.cacheKey` already name the exact entry, so a one-liner
   (`rm "$SKIM_DIR/<key>".*`) is the documented undo; (b) a tiny
   `--forget <key>` helper is a nice-to-have but not required for ratification.
3. **Noticing at all (this is the real dependency on ticket 005).** A user cannot
   undo what they never saw. The sidecar already records `servedFromCache: true`
   and `savedInputTokens` on every hit, which is the raw material. The ticket-005
   dashboard must surface, at minimum: hits over time, the specific requests
   served from cache, and an easy path from a suspicious reply back to its
   `cacheKey`. Recommend the dashboard also flag "hit whose stored reply is older
   than N minutes" and "hit on a request whose messages contained a
   `tool_result`" as elevated-risk rows.

Ratification needed on: whether per-entry forget must be a built tool vs.
documented `rm`, and exactly which risk signals the dashboard elevates.

## Q3 — What must never be cached?

**Recommendation: never store any of the following, and enforce it at
*store* time, not just read time.**

| Class | Current prototype | Recommendation |
| --- | --- | --- |
| Non-200 / error responses | Already excluded — `store()` only runs on `statusCode === 200`. | Keep. Also never cache `4xx`/`5xx`, `overloaded_error`, or any body containing an `error` event even under a 200 line. |
| Partial / truncated streams | **Gap** — a 200 with a cut-off body is stored. | **Add a completeness check before storing:** require a terminal `message_stop` (and a `message_delta` carrying `stop_reason`) in the reassembled SSE. `decodeResponse()` already parses `stop_reason`; store only when it is present. Drop anything else. |
| Requests carrying secrets | **Gap** — hashed and stored opaquely. | Do not cache a request whose headers or body suggest live credentials beyond the standard auth header (e.g. a `tool_result`/message body containing token-shaped material). At minimum, exclude when the body carries auth-like content; the standard `authorization`/`x-api-key` request header is fine to ignore since it is identical across a user's session and never stored (`REDACT`). |
| Requests carrying `tool_result`s | **Gap** — cached like anything else. | **Exclude by default.** A `tool_result` is a snapshot of external state (a file read, an API response, a shell output) captured at request time; replaying its downstream answer later is the poison case in Q4. Gate on `messages[].content[].type === "tool_result"` and skip. This is the single highest-value exclusion and should be the default; a `SKIM_CACHE_TOOL_RESULTS=1` escape hatch can exist for power users who accept the risk. |
| `count_tokens` | Already excluded (`isTokenCount`). | Keep. |
| Non-streaming `/v1/messages` | Already excluded (gate requires `stream === true`). | Keep for now; revisit only if a non-SSE replay path is built. |

The unifying principle to ratify: **only cache a reply that is (a) complete,
(b) a 200, and (c) a pure function of the request text — no embedded live state or
secrets.** `tool_result`-bearing requests fail (c) and are the main thing to
carve out beyond what the prototype already excludes.

## Q4 — Poison / staleness bound

**Recommendation: bound the cache on all three axes the prototype currently
leaves open, and treat "identical request, changed world" as unservable rather
than merely time-expired.**

- **Max TTL.** Keep `SKIM_TTL_MS` but recommend a *lower* default than 1h for the
  general case — on the order of **5–15 minutes** — because the byte-exact key
  cannot tell a stable question from one whose truthful answer depends on
  now-changed state. 1h is fine for genuinely static prompts and should stay
  configurable, but the safe default should be short. Ratify the exact number.
- **Max entries + eviction.** Add a bound the prototype lacks:
  `SKIM_MAX_ENTRIES` (suggest a few thousand) with **LRU/oldest-first eviction**,
  plus opportunistic deletion of files already past TTL during `lookup`/`store`
  (today they linger forever). This keeps `SKIM_DIR` from growing unbounded and
  caps blast radius.
- **Stored reply references changed state.** This is the case the byte-exact key
  *cannot* detect on its own — two identical request bodies can have different
  correct answers if the world moved between them (a file changed, a clock
  advanced, a `tool_result` went stale). Recommended layered defense, in order of
  cost:
  1. **Exclude the obvious carriers** (Q3): `tool_result`-bearing requests are the
     main way changed state enters a byte-identical request, so not caching them
     removes most of this risk outright.
  2. **Short TTL** (above) bounds how long any stale answer can survive.
  3. **Explicit invalidation hooks** are out of scope for byte-exact keying and
     belong to the semantic/dependency-aware layer named in the map's "Not yet
     specified." Do not promise dependency invalidation here; note it as the next
     ticket.
- **Fail safe, not loud.** Preserve the prototype's discipline that a bad/stale
  entry falls through to a live upstream call (`lookup` returns `null`) and that a
  failed write never breaks the proxy (`store` is best-effort). Any new guardrail
  must keep that property: when in doubt, miss and call upstream.

Ratification needed on: the default TTL number, the max-entry count, and whether
eviction is LRU vs. simple oldest-first.

---

## Summary of recommendations (all proposed, none ratified)

1. **Posture:** opt-in forever for the whole skim; on-by-default only later, only
   for a proven-safe slice, only after guardrails + dashboard.
2. **Kill switch/observability:** keep `SKIM_CACHE` global off; document per-entry
   `rm` undo keyed by the sidecar's `cacheKey`; depend on ticket-005 dashboard to
   make hits (and risky hits) visible.
3. **Never cache:** non-200s (done), **partial streams** (add `message_stop`
   completeness check), **`tool_result`-bearing requests** (new default
   exclusion), secret-bearing bodies; keep `count_tokens` and non-streaming out.
4. **Staleness bound:** shorten default TTL to ~5–15 min, add
   `SKIM_MAX_ENTRIES` + eviction + expired-file cleanup, exclude live-state
   carriers rather than trying to invalidate them under byte-exact keying.

The lowest-effort, highest-value single change is the `tool_result` exclusion plus
the stream-completeness check — both close real gaps in the current code and both
preserve the "miss and call upstream when unsure" safety property.
