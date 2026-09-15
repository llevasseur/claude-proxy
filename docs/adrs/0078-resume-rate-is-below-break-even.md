---
type: adr
title: The measured resume rate is below break-even, and the 8-hour default ships anyway
description: Only 9.6% of sessions resumed after a cache-expiring gap against a 15.5% break-even, so session-start registration at 8 hours is measurably net negative; the specified shape ships and the finding is recorded for a human to decide.
tags: [proxy, cache, usage-limits, measurement, product]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 5
needs-human: true
---

# The measured resume rate is below break-even, and the 8-hour default ships anyway

## Status

Proposed by `/dev` running unattended. **A human has not ratified this decision, and this
is the one a human most needs to read.** An unattended run measured the feature's core
premise, found the evidence does not support the specified default, built the specified
default anyway because the user stated it twice, and recorded the finding here.

## Context

The griller's question, verbatim in part:

> "the design spends the most on exactly the sessions that are never coming back, and the
> invocation shape makes that the default case rather than the edge … The feature's maximum
> spend and its zero return are the same case. An abandoned session and a long away-stretch
> are indistinguishable from inside the proxy, because the only signal it has is silence.
> … `/task --add warm` fires once at the start, when neither the agent nor the user yet
> knows whether this session will be paused or simply finished … If 'ended' dominates, the
> honest conclusion is not a tighter cap but that REGISTRATION IS AT THE WRONG MOMENT."

## Decision

### The measurement

Same archived day, keyed on `session.sessionId`, cache-expiry threshold 60 minutes:

    distinct sessions 52 · requests 3,291
    went quiet >60 min and then produced another request:  5  (9.6%)
    session lifetime (first->last), minutes: p50 9.9 · p90 110.2 · max 214.9
    sessions with exactly one request: 9

The five resume events in full:

| Away | Requests after |
|---|---|
| 78.8 min | 96 |
| 81.2 min | 28 |
| 83.7 min | 49 |
| 139.4 min | 1 |
| 214.9 min | 1 |

Three are genuine returns to work. Two produced a single trailing request and are near
worthless. **The honest hit rate is 5.8%–9.6%.**

Note `max 214.9` minutes: **no session in the corpus lived past 3.6 hours.** The 8-hour
cap is not merely unsupported by this evidence — it was never exercised by it.

### The break-even

Using the units [0073](0073-keep-alive-is-justified-in-usage-units.md) establishes, on a
200k prefix:

    per ping               200,000 * 0.02  =   4,000 units
    cold write avoided     200,000 * 1.0   = 200,000 units
    net benefit on a hit                   = +196,000
    cost of a miss at hours=8 (9 pings)    =  -36,000

    break-even p = 36,000 / 232,000 = 15.5%

**Measured 9.6% against a 15.5% break-even.** Blanket registration at an 8-hour deadline
is net negative — by roughly 3x had all 52 sessions been registered.

The deadline is the lever, because it sets the cost of a miss:

| hours | pings on a miss | miss cost | break-even |
|---|---|---|---|
| 8 | 9 | −36,000 | 15.5% — **below base rate, loses** |
| 4 | 5 | −20,000 | 9.3% — marginal |
| 2 | 2 | −8,000 | 3.9% — **pays even under blanket registration** |

### What ships, and what is recommended

**Ships as specified.** `POST /__warm {sessionId, hours}` clamped to a maximum of 8, and
the `/warm` command sends 8. The user stated this shape explicitly and in writing. A grill
produces evidence, not authority, and an unattended run does not quietly reverse a
twice-stated instruction.

**Recommended to a human, in priority order:**

1. **Move registration to the moment of stepping away**, not session start. The
   `/task --add warm` shape registers before anyone knows whether the session will be
   paused or simply finished, which is what makes the never-resumed case the default
   rather than the edge.
2. **Drop the default to 2 hours**, keeping 8 as an explicit opt-in ceiling. That alone
   moves break-even to 3.9%, below even the pessimistic measured rate.

**Instrumentation that settles this from the user's own traffic.** `warm.json` records per
entry `pingsSent` and a terminal `outcome` of `resumed`, `expired`, or `stopped-<reason>`.
After a week of real use the hit rate is measurable against the 15.5% line, and nobody has
to take one archived day's word for it.

## Consequences

- The feature ships in a configuration this record shows to be net negative under blanket
  registration. That is deliberate, disclosed, and reversible by changing one number.
- **Limits of the day measured, stated rather than generalised:** one account, one working
  day, capture ending 20:30 so long away-stretches are right-censored, and **no overnight
  away-stretch in the sample at all** — which is the headline use case. The self-measuring
  instrumentation matters more than the archived number precisely because of this.
- If the measured hit rate lands above 15.5% in real use, the specified default is
  vindicated and this record should be superseded saying so.
