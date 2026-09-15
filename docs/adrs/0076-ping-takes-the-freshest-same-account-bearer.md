---
type: adr
title: A keep-alive ping takes the freshest same-account bearer, never the stored one
description: A warm entry is defined by the absence of traffic, so its captured credential ages with nothing to refresh it; the ping borrows the newest bearer seen for the same account, and 401 becomes a named reported stop.
tags: [proxy, cache, credentials, usage-limits]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 3
needs-human: true
---

# A keep-alive ping takes the freshest same-account bearer, never the stored one

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision. It concerns
how a credential is reused, which is a human's call.

## Context

The griller's question, verbatim in part:

> "the stored credential goes stale precisely because the session went quiet, and the
> design's own stop conditions turn that into a silent no-op … A warm session is defined by
> the absence of traffic. Nothing will ever refresh its stored bearer … The likely outcome
> is a 401 partway through the window. The listed stop conditions then make that invisible:
> 401 is not named (only 429 and 529 are), so it falls through to 'two consecutive ping
> failures' and the entry is dropped quietly … borrowing a different session's newer
> bearer … may not even be the same account."

`noteAuth` keeps the newest forwarded bearer, and that refresh channel works only because
traffic keeps flowing. A warm entry is precisely the case where it does not.

## Decision

**The ping replays the stored body and the stored non-auth headers, and takes the newest
bearer observed for the same `account_uuid` at send time.**

The measurement that decides it. Scanning the same archived day, keyed on
`session.account`:

    requests 3,291 · accounts 1 · distinct sessions 52
    span 12:52:59Z -> 20:30:10Z  (7h37m)
    account-level gaps between consecutive requests, minutes:
      p50 0.06 · p90 0.24 · p99 0.92 · max 29.2
    gaps > 50 min: 0 of 3,290

Two readings follow. **52 distinct sessions on one account in one day** — "I run several
sessions at once" is the operating condition, not colour. And the account never went
quiet for longer than 29.2 minutes against a 50-minute ping interval, with zero gaps above
50 minutes. When a ping fires, the proxy's newest observed bearer is at worst about 29
minutes old, while the entry's captured one is hours old.

So the fix is not to solve token refresh. It is to stop pinning the credential to the
entry.

1. The warm entry stores `account` alongside the session key.
   `extractSession` already parses `account_uuid` out of `metadata.user_id`.
2. A bearer is reused **only** within a matching account. There is **no cross-account
   fallback** — the borrowing objection is exactly why the scoping is mandatory rather
   than incidental.
3. If no bearer is held for that account, the ping does not fire and the entry reports
   why.
4. The credential stays in memory only. It never reaches `warm.json`, never reaches a
   sidecar, and dies with the process — the existing rule, unchanged.

**401 and 403 become named, separately reported stop conditions**, distinct from "two
consecutive ping failures". A credential expiry is a different event from an upstream
wobble, and laundering it into a generic counter is the silent failure this record exists
to prevent. The reason is written to `warm.json`, so a returning user reads
"stopped — credential expired" rather than finding the entry simply gone.

## Consequences

- `usage-live.ts` holds one global bearer today; this needs it keyed by account. That is a
  small widening of an existing mechanism, not a new one.
- **The bearer's lifetime is unmeasured and cannot be measured from anything on disk.**
  Audit sidecars carry no headers at all — the top-level keys are `timestamp, model,
  endpoint, statusCode, session, tokens, request, skim, tools, rateLimit` — and `REDACT`
  in `proxy.ts` never lets one through. [ADR 0019](0019-sanitized-audit-sidecars.md) is
  why, and that is the right trade; it simply closes this measurement off.
- The gap measurement covers the case the feature was specified for: several sessions
  running, step away from **one**. It does **not** cover every session going idle at once.
  In that all-idle case the stored bearer is all there is, and **the real ceiling is the
  token's lifetime rather than 8 hours**. The 8-hour cap is a policy ceiling, not a
  demonstrated one.
