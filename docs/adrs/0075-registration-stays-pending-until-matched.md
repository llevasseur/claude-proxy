---
type: adr
title: A warm registration stays pending until a real request matches it
description: The header and metadata session ids are measured equal across 3,291 requests, but the CLAUDE_CODE_SESSION_ID env var is a third string nobody has joined, so registration is a handshake rather than an assertion.
tags: [proxy, cache, session, measurement]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 2
---

# A warm registration stays pending until a real request matches it

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision.

## Context

The `/warm` command sends `$CLAUDE_CODE_SESSION_ID` to the proxy, which must match it
against a session it has seen. The brief named this the feature's one unverified link, and
could not settle it: the user believed today's raw logs were empty and the archive kept
digests only.

That belief was wrong in a useful way. `~/Documents/logs/claude/2026-08-05/raw/` holds
10,065 files — full request bodies and audit sidecars for 3,352 requests. One archived day
survives the out-of-repo pruner described in
[the retention lifecycle](../features/retention-lifecycle.md), and it is enough.

## Decision

**Keep the registration pending until a real request matches it, and expire it after two
minutes with a reported reason.** Two of the three links are now measured; the third is
not, and the handshake is what fails loudly on the one still unproven.

### Link 1–2: measured equal, n = 3,355

Every audit sidecar for that day was scanned, comparing `session.sessionId` (from the
`x-claude-code-session-id` header) against `session.metadataSessionId` (from
`metadata.user_id.session_id`):

    both present and EQUAL : 3,291
    both present, DIFFERING:     0
    header only            :     0
    metadata only          :     0
    neither                :    64   (count_tokens and similar)

**The two are always equal when present, and never one-sided.** That retroactively
justifies `sessionKey = sender.sessionId ?? sender.metadataSessionId` in
[`proxy.ts`](../../stacks/claude/proxy/proxy.ts), which until now was a coalesce over an
unverified pair.

### Link 3: not measured

`CLAUDE_CODE_SESSION_ID` — the environment variable the `/warm` curl reads — is a third
string, and it was **not** joined to the other two. The attempt and why it failed are
recorded so nobody repeats it: this device's session routes through a different
`ANTHROPIC_BASE_URL`, nothing listens on the claude proxy's port, and the surviving
transcripts predate the attempt. Closing it would mean driving a live client through a
running proxy with permission flags, which an unattended run does not take.

So the proxy matches an incoming registration against **either** the header **or**
`metadata.user_id.session_id`, treats the registration as `pending` until a forwarded
request matches, and expires it at two minutes with the reason recorded in `warm.json`.
A registration that never matches reports that it warmed nothing, rather than sitting
silently warming nothing.

## Consequences

- The failure mode the brief feared — silently warming nothing — is unreachable: an
  unmatched registration is a reported outcome.
- If link 3 is later measured equal, the handshake becomes redundant but stays; it costs
  one matched request and removes an assumption.
- The measurement covers one account on one working day. It is strong on the
  header-versus-metadata question because the sample is large and perfectly consistent,
  and it says nothing at all about the environment variable.
