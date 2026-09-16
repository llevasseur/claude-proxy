# warm-cache-01 — The keep-alive module

**Wayfinder:** `warm-cache`
**Branch:** `task/warm-cache-01-keepalive-module`
**Status:** done · 2026-09-15

This ticket is the campaign's spine — ticket 02 codes against what this exports. It adds
**one new file plus its test** and edits no existing source, which is what keeps it in the
same wave as tickets 03 and 04.

## Criteria

1. **Add `stacks/claude/proxy/keepalive.ts`.** Zero runtime dependencies, Node built-ins
   only, in-memory only. Explicit `.ts` import extensions, matching its siblings.

   **Do not name it `warm.ts`, and do not export an identifier built on `warm`.**
   `cache-breakpoint.ts` already owns that word in this package — `warmSessions`,
   `hasWarmPrefix`, `WARM_LIMIT`, `_resetWarmPrefixes` — where it means "this session has
   been observed reading past its own system prefix". A second, unrelated meaning in the
   same directory collides for every future reader. See
   [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) §5. The file's header comment
   must state the distinction outright. The `/__warm` endpoint and the `/warm` command
   keep their names — they face outward, not into this package.

2. **The registry.** A map from session key to an entry holding at least: the stored
   forward body, the stored non-auth headers, the `account` (the `account_uuid` from
   `metadata.user_id`), `deadline`, `lastActivity`, `ttlMs`, `state`, `pingsSent`,
   cumulative cache-read tokens, and a terminal `outcome`.

   `state` is one of `pending`, `armed`, or `stopped`. **Never write a body, prompt, or
   credential to disk** — this is a repository rule, not a preference.

3. **Body stripping, and it is the tested core.** A ping is the stored body re-sent with
   `max_tokens: 0`. That is an `invalid_request_error` in combination with any of:
   - `stream: true`
   - `thinking.type: "enabled"`
   - `output_config.format`
   - a forced `tool_choice` — `{"type":"any"}` or `{"type":"tool"}`

   Remove exactly those and **change nothing else**: every other byte must survive or the
   cached prefix stops matching. `tool_choice: {"type":"auto"}` is *not* forced and must be
   left alone. Streaming is transport and is not part of the cached prefix, so dropping it
   costs no cache hit.

   Measured on 3,292 real archived request bodies, so the strips are not hypothetical:
   `stream: true` on 2,281, `output_config` on 2,314, a forced `tool_choice` on 1, and
   `thinking.enabled` on 0 — the last is defensive rather than observed, and still tested.

4. **TTL derivation, never hardcoded.** Read the TTL off the `cache_control` already on the
   stored body — the same value `cache-breakpoint.ts` clones rather than rebuilding, for
   the same reason: a client-side TTL change must carry through without a proxy edit. Every
   `ttl` in the measured corpus is `"1h"`; derive it anyway. Fall back to a documented
   default when no `cache_control` carries one.

5. **The sweeper.** One timer for the whole registry, not one per entry. It fires a ping
   when `now - lastActivity` exceeds roughly **83%** of that entry's TTL and `now` is
   before its `deadline`. Entry lifetime is measured from the *start* of the request that
   reads or writes it, which is why the interval is padded rather than fired at expiry —
   83% of 1h is ~50 minutes. `unref()` the timer so it never holds the process open, as
   `startUsagePolling` does.

6. **The deadline clamp.** `hours` is clamped to a maximum of **8**. Clamp the upper bound,
   reject a non-finite or non-positive value, and make the clamp a pure exported function
   so the test can reach it without a timer.

7. **The ping transport.** The module issues its **own** `https.request` to the upstream.
   A ping must never enter `handle()`. That single choice is what bypasses the skim cache
   and skips `appendSession`, `auditRequest`, `recordPrompt`, `writeAuditSidecar` and
   `noteCacheRead` — all of them, at once, because none is reachable from outside
   `handle()`. **Do not implement this as an enumerated list of things to skip**; a list is
   an invitation to miss the next side effect somebody adds to `handle()`. See
   [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) §1.

   `noteCacheRead` is the sharpest case: feeding it a cache read the proxy manufactured
   would mark the session warm on self-made evidence, and that flag feeds
   `ensureMessageBreakpoint`'s gate.

8. **Credentials.** The ping takes the **newest bearer observed for the same
   `account_uuid`** at send time, never the one captured with the entry. No cross-account
   fallback, ever. With no bearer held for that account the ping does not fire and the
   entry records why. See [ADR 0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md),
   which carries the measurement behind it. Expose whatever seam this needs; ticket 02
   wires the account-keyed bearer store.

9. **Stop conditions**, each recording a distinct reason:
   - the hard 8-hour deadline;
   - a real request arriving — reset `lastActivity` and skip the ping;
   - two consecutive ping failures;
   - a 429 or 529;
   - **401 or 403, named and reported separately** — never folded into the consecutive-failure
     counter. A credential expiry is a different event from an upstream wobble, and
     laundering it into a generic counter is the silent failure
     [ADR 0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md) exists to
     prevent;
   - usage-limit utilization above a threshold, read from `usage-live.json` — **Anthropic's
     own meter, not the local sidecar corpus.** Do not compute this from sidecars; see
     [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) §2;
   - proxy restart, which self-clears because state is memory-only.

10. **Tests in `stacks/claude/proxy/keepalive.test.ts`, with `node --test`**, matching the
    sibling proxy tests. Cover at minimum: each of the four strips individually; that a
    non-forced `tool_choice` survives; that an otherwise-untouched body is byte-identical
    after stripping; TTL derivation including the no-`cache_control` fallback; and the
    8-hour clamp, including a value above 8, a value below the floor, and a non-finite one.

    Export a test seam to reset module state, as `_resetWarmPrefixes` and `resetAuth` do.

## Out of scope

Any edit to `proxy.ts` — that is ticket 02. Any admin UI — see
[ADR 0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md).

## Done when

`my-command-tools verify` passes, and the new tests run under the proxy package's existing
`node --test` script.
