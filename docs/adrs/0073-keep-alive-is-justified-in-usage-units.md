---
type: adr
title: Justify the keep-alive in subscription usage units, not dollars
description: The cost case for holding a cache warm is stated in usageUnits against the 5h and week windows; the dollar figures are context only.
tags: [proxy, cache, usage-limits, cost]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
grill-round: 1
needs-human: true
---

# Justify the keep-alive in subscription usage units, not dollars

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision.

## Context

The griller's question, verbatim in part:

> "the cost justification is denominated in a currency this account does not spend …
> `usage-live.ts` polls `https://api.anthropic.com/api/oauth/usage` off a forwarded OAuth
> bearer … That points at a Claude subscription, where the binding constraint is the
> 5-hour window and the weekly cap rather than dollars. The idea's economics
> ('≈$0.10/ping, ≈$0.90 for 8h, versus ≈$2.00 for the single 2x cold write on return')
> are per-token API list-price arithmetic. On a subscription there is no $2.00 on the
> other side of the ledger to save … Either (a) the claim is that a keep-alive ping's
> quota cost is materially less than the cold write it avoids — in which case, on what
> measurement — or (b) the real benefit is latency, not cost."

The feature brief priced a keep-alive ping in dollars. This account meters on a
subscription, so the dollar figures describe a currency it does not spend.

## Decision

**State the justification in `usageUnits`, the metering unit
[`stacks/claude/core/src/usage-limits.ts`](../../stacks/claude/core/src/usage-limits.ts)
already defines, against the `5h` and `week` windows `USAGE_WINDOWS` declares.** Demote
the dollar figures to context.

That file already anticipated and answered this objection. Its own words: what a cache
read meters at against fresh input "is **not** the cost ratio: Anthropic bills cache reads
at about a tenth of fresh input … and metering at that tenth reads every cache-heavy
window several times too high." The measured weight is `CACHE_READ_METERING_WEIGHT = 0.02`,
and the unit is:

    usageUnits(t) = t.input + t.output + t.cacheCreation + t.cacheRead * 0.02

For a 200k-token prefix:

| Event | Tokens | Weight | usageUnits |
|---|---|---|---|
| One keep-alive ping | 200,000 cache read | 0.02 | 4,000 |
| Nine pings over 8 hours | — | — | 36,000 |
| The cold write avoided | 200,000 cache creation | 1.0 | 200,000 |

**A keep-alive is roughly 5.5x cheaper than the cold write it avoids** — a wider margin
than the dollar figures implied, not a narrower one. `usageUnits` weights `cacheCreation`
flat at 1.0 regardless of TTL, so the 1h breakpoint's 2x price premium does not appear in
quota at all.

The conclusion survives the uncertainty the source file declares. It calls the weight
"held loosely — the order of magnitude is solid, the second digit is not", with plausible
values spanning 0.011–0.023. At the pessimistic end nine pings cost 41,400 units, still
under a quarter of one cold write.

**Stop condition 4 is therefore a budget, not a brake.** It is expressed in `usageUnits`
against the `5h` and `week` windows, never in dollars and never in a raw ping count.

## Consequences

- The feature is justified in the unit the account is actually billed in, and the
  justification is checkable against a constant this repository derives and pins.
- Latency (time to first token) is a real secondary benefit and is deliberately **not**
  load-bearing: the case rests on quota alone.
- The saving is conditional on the user returning. A session never resumed spent its
  pings for nothing — see [0078](0078-resume-rate-is-below-break-even.md), which measures
  how often that happens and is the decision a human most needs to review.
- A future change to `CACHE_READ_METERING_WEIGHT` changes this arithmetic. The margin is
  wide enough that the conclusion does not turn on the second digit.
