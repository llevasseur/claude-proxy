---
type: adr
title: The cached prefix survives local midnight, so the deadline is not capped at it
description: The date Claude Code shows the model sits at message 0, not in the cached system blocks, so an 8-hour warm window may cross midnight without invalidating the prefix.
tags: [proxy, cache, prompt-caching, measurement]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 2
---

# The cached prefix survives local midnight, so the deadline is not capped at it

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision. The
decision rests on a measurement, and the measurement's limits are stated below.

## Context

The griller's question, verbatim in part:

> "the feature warms a stored *body*, but what pays off is the *prefix the returning
> request sends*, and nobody has checked those are still equal 8 hours later … The
> concrete case is local midnight. Claude Code's system prompt carries an environment
> block with the current date … An 8-hour cap all but guarantees crossing midnight for the
> headline use case — step away in the evening, return in the morning … that is 36,000
> usageUnits spent for zero … should the 8-hour cap become 'expire at the earlier of 8
> hours or the next local midnight' until someone measures it?"

If any part of the cached prefix is derived from the clock, the prefix breaks at that
block on return and every ping bought nothing — silently, and in exactly the case the
feature exists to serve.

## Decision

**Do not cap the warm window at local midnight.** The cached prefix is byte-stable across
a midnight boundary, measured rather than assumed.

Method. A real archived request body was parsed from the one surviving raw capture,
`~/Documents/logs/claude/2026-08-05/raw/2026-08-05T15-35-38-892_anthropic.request.txt` —
2.4 MB, 174 messages, 3 `system` blocks.

- The `system` field was searched for `Today's date is` and for any `<env>` or
  "current date" marker: **no match**. The date is not in `system` at all, and neither of
  the two `ttl: "1h"` breakpoints `cache-breakpoint.ts` describes carries a clock-derived
  value.
- `Today's date is 2026-08-05.` appears exactly once in the whole request, at
  **`messages[0]`, role `user`** — of 174 messages.

Message 0 is written when the session starts and is never rewritten; the client appends
turns rather than re-rendering history. At T+8h the date string in the prefix is *stale*
but *identical*, and a cache match is a byte comparison rather than a semantic one.
Staleness costs the model a correct idea of the date. It costs the cache nothing.

Capping at midnight would halve the feature for the exact use case it exists to serve —
step away in the evening, return in the morning — on an assumption the evidence
contradicts.

## Consequences

- The deadline is bounded by the 8-hour cap alone.
- A returning session may carry a stale date into the model's context. That is the
  client's existing behaviour after any long-lived session, not something this feature
  introduces.
- **Limits of the measurement, stated rather than generalised:** one request, one day, one
  client version (`claude-cli/2.1.222`). It establishes that the date is not in `system`
  and sits at message 0 *on this client*. A future client that re-renders message 0, or
  that moves the environment block into `system`, breaks this silently. Re-measure before
  trusting it across a client upgrade — this is a fact about an observed version, not a
  law.
- The same corpus settles two further questions:
  [0075](0075-registration-stays-pending-until-matched.md) and
  [0078](0078-resume-rate-is-below-break-even.md).
