---
type: adr
title: A keep-alive ping never enters handle, and is ledgered in warm.json rather than the audit corpus
description: Routing the ping outside handle makes the skip list architectural rather than enumerated; the audit sidecar schema is untouched, and claude's transparent-forwarding invariant is written down with its first break attached.
tags: [proxy, cache, architecture, privacy, transparency]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 4
needs-human: true
---

# A keep-alive ping never enters handle, and is ledgered in warm.json rather than the audit corpus

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision.

## Context

The griller's question, verbatim in part:

> "THE QUESTION: what is a keep-alive ping, in the record? … If a ping WRITES a sidecar,
> the source of truth records nine requests per warm session per window that no human
> made. Every downstream reader inherits them: SQLite, cost and context-size analytics,
> the daily summary, the suggestions pipeline, and noteCacheRead — which would mark a
> session as having a warm message prefix on the strength of a cache read the proxy itself
> manufactured … If a ping WRITES NOTHING, then quota the proxy spent on the user's behalf
> is invisible in the record the round-1 usageUnits budget is computed from."

The brief named two side effects to skip — the skim cache and `appendSession` — and was
silent on every other one reachable from `handle()`.

## Decision

### 1. The ping never enters `handle()`

The keep-alive module issues its own `https.request` to the upstream. A ping does not pass
through `handle()` at all, so `auditRequest`, `recordPrompt`, `writeAuditSidecar`, the
`.md` / `.request.txt` / `.audit.json` triple, and `noteCacheRead` are never reached.

**The brief's list of two was incomplete, and a longer list is the wrong remedy.** A
list of things to skip is a standing invitation to miss the next side effect somebody adds
to `handle()`. A path that never acquires them cannot miss one.

`noteCacheRead` is the sharpest instance. Feeding it a cache read the proxy manufactured
would mark the session warm in the `warmSessions` ledger on self-made evidence, and that
flag feeds `ensureMessageBreakpoint`'s gate — so the proxy would inject breakpoints on the
strength of its own pings. Against 52 sessions a day that is not a rounding error. Not
calling it now falls out of the architecture rather than being remembered.

### 2. The budget reads Anthropic's meter, not the local corpus

Stop condition 4 reads `usage-live.json`, which `usage-live.ts` populates by polling
`https://api.anthropic.com/api/oauth/usage` — **Anthropic's own utilization figures**.
Anthropic billed the pings, so that meter already counts them. There is no blind spot.

This is written down because the blind spot would be easy to create later by "fixing" the
budget onto the sidecar-derived corpus. **Do not.**

What *is* under-counted is the repo's own derived analytics — SQLite, cost and
context-size analytics, the daily summary — which will sit below Anthropic's utilization
by exactly the ping spend. That gap is real and is made legible by the ledger below rather
than left to puzzle whoever notices the two numbers disagreeing.

### 3. `warm.json` is the ledger; the sidecar schema is untouched

A ping is **proxy-originated traffic, recorded in the proxy's own status file, never in
the audit corpus.** `warm.json` carries, per entry and in aggregate: pings sent,
cumulative cache-read tokens, `usageUnits` computed with `CACHE_READ_METERING_WEIGHT`, and
the stop reason when one fires. Counts, timestamps and reasons only — no body, no prompt,
no credential — so the repository rule holds and it mirrors `usage-live.json` in shape and
spirit.

**A typed origin field on the sidecar is rejected.**
[ADR 0019](0019-sanitized-audit-sidecars.md) makes that a schema decision, and it would
put proxy-originated traffic inside the corpus AGENTS.md names the source of truth for
what the client sent. Every reader would then have to learn to exclude it, and the failure
mode is that one forgets and counts turns no human took.

### 4. claude's transparent-forwarding invariant, written down

**There is no `scope: claude` ADR stating a transparent-forwarding promise.**
[ADR 0024](0024-transparent-http-surface.md) carries `scope: all` in frontmatter while its
own Provenance section says in words "Governs the `codex` and `ox-alpha` stacks". claude's
observer posture lives in `proxy.ts`'s header docstring and in
`core/src/filters.ts`. This record states it for the first time, with its break attached:

> The claude proxy forwards client traffic unchanged apart from the deliberate edits
> `filters.ts` inventories, **and may originate upstream requests of its own.**

That is not new. `startUsagePolling` in `usage-live.ts` already fires an unref'd
60-second timer at the OAuth usage endpoint, authenticated with a bearer remembered off
forwarded traffic, with no client request behind it. What this feature widens is the
*kind*: from a cheap metadata call to a 200k-token inference call that spends the user's
quota. The widening is real and is stated rather than elided.

### 5. The module is named off the existing `warm` identifier

`cache-breakpoint.ts` already owns `warm` in this package — `warmSessions`,
`hasWarmPrefix`, `WARM_LIMIT`, `_resetWarmPrefixes` — meaning "observed reading past its
own system prefix". The new module takes a different name and states the distinction in
its header. The `/__warm` endpoint and the `/warm` command keep their names, which the
user specified and which face outward rather than into this package.

## Consequences

- No downstream reader changes, because nothing new enters the corpus they read.
- The ping path does not inherit future side effects added to `handle()`. It also does not
  inherit future *fixes* added there, which is the cost.
- `warm.json` is the only place ping spend is visible locally. Losing it loses the ledger;
  it is status, so that is an acceptable loss.
