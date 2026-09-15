# warm-cache-02 — The control endpoint, the capture, and warm.json

**Wayfinder:** `warm-cache`
**Branch:** `task/warm-cache-02-proxy-wiring-and-status`
**Status:** active

Wires ticket 01's module into `handle()`. **Runs after 01 has landed on
`wayfinder/warm-cache`**, because it codes against what that module exports. This is the
only ticket that edits `proxy.ts`.

## Criteria

1. **The control endpoint, checked before the upstream forward.** In `handle()`, ahead of
   the skim gate and the forward, handle three methods on `/__warm`:

   | Method | Body | Does |
   |---|---|---|
   | `POST` | `{sessionId, hours}` | registers; `hours` clamped to a maximum of 8 |
   | `DELETE` | — | cancels the registration |
   | `GET` | — | lists current entries |

   **Bound to 127.0.0.1 only.** Reject a request whose remote address is not loopback,
   whatever `HOST` is set to — the proxy can be bound to all interfaces with `HOST=""`,
   and this endpoint must not follow it out. Reply in JSON, and never echo a stored body.

   `isTokenCount(reqPath)` and the skim gate must not see these requests: return before
   either.

2. **Registration is a handshake, not an assertion.** A new registration is `pending`. It
   becomes `armed` only when a real forwarded request matches its `sessionId` against
   **either** the `x-claude-code-session-id` header **or** `metadata.user_id.session_id`.

   `extractSession` already reads both, and `handle()` already computes
   `sessionKey = sender.sessionId ?? sender.metadataSessionId`. Those two were measured
   equal across 3,291 requests with zero disagreement, but the environment variable the
   `/warm` command sends is a third string that has **not** been joined to them — which is
   exactly why the handshake exists. See
   [ADR 0075](../adrs/0075-registration-stays-pending-until-matched.md).

   **A registration unmatched after 2 minutes expires**, with the reason recorded. It must
   never sit silently warming nothing.

3. **The capture.** After a successful forward, and **only for a session that has
   registered**, store into the module: the `forwardBody` actually sent (not the raw
   `body` — the forwarded bytes are what the upstream cached), the non-auth request
   headers, and the `account`. Refresh `lastActivity` on every real request for a
   registered session, which is also the "a real request arrived" stop condition.

   Store nothing for unregistered sessions. This is what keeps the feature off the hot
   path for every session that never asked for it.

4. **The account-keyed bearer store.** `usage-live.ts` keeps one global bearer via
   `noteAuth`. Widen it so a bearer is retrievable **by `account_uuid`**, and have
   `handle()` record the account alongside it. Keep the existing single-bearer behaviour
   working for the usage poll — this is a widening of an existing mechanism, not a
   replacement. The bearer stays in memory only: never written to `warm.json`, never to a
   sidecar, and gone on restart.

5. **`logs/warm.json`.** Mirror status into `LOG_DIR`, in the shape and spirit of
   `usage-live.json`: build the document, write it to a `.tmp` sibling, then `rename` it
   into place, which also wakes the server's existing log-directory SSE watcher.

   It carries, per entry and in aggregate: the session key, `state`, `pingsSent`,
   cumulative cache-read tokens, `usageUnits` spent, the deadline, and the terminal
   `outcome` — one of `resumed`, `expired`, or `stopped-<reason>`.

   Compute `usageUnits` with `CACHE_READ_METERING_WEIGHT` from
   `stacks/claude/core/src/usage-limits.ts` — **the proxy has zero runtime dependencies, so
   do not import the core package.** Mirror the constant with a comment naming
   `usage-limits.ts` as the source, exactly as `system-prompt.ts` mirrors
   `wire-prompt.ts`, and pin the two together in a test if that is cheap.

   **Status only. No body, no prompt, no credential.**

   The `outcome` field is not decoration: it is the instrument
   [ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md) needs to settle the resume
   rate against its 15.5% break-even from the user's own traffic.

6. **Do not touch the audit sidecar schema.** A ping is proxy-originated traffic recorded
   in `warm.json`, never in the audit corpus, and no typed origin field is added to the
   sidecar. See [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md) §3 for why that was
   rejected rather than overlooked.

7. **Tests.** Extend `stacks/claude/proxy/proxy.test.ts` or add beside it: the loopback
   check rejects a non-loopback caller; `POST` clamps `hours` above 8; a pending
   registration arms on a matching header id and on a matching metadata id; and an
   unmatched registration expires. Assert that no `warm.json` write ever contains a
   distinctive body marker — [ADR 0019](../adrs/0019-sanitized-audit-sidecars.md) requires
   proxy tests to prove secret and body markers never reach an artifact, and this is a new
   artifact.

## Out of scope

The module itself and its ping transport — ticket 01. Any admin route or card — see
[ADR 0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md).

## Done when

`my-command-tools verify` passes, and `logs/warm.json` appears with a registered session
and disappears from nothing else.
