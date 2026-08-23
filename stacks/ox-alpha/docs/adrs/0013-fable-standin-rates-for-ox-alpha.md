---
type: adr
title: Price Ox Alpha with Claude Fable 5 rates as a stand-in
description: Record that x-preview-f-free carries borrowed Anthropic rates, and that they model a hypothetical price rather than one billed.
tags: [architecture, pricing, ox-alpha]
timestamp: 2026-08-22
decided-by: /god
ratified: false
wayfinder: ox-alpha-proxy
needs-human: true
---

# Price Ox Alpha with Claude Fable 5 rates as a stand-in

## Status

Requested explicitly by the operator, recorded here rather than applied
silently. A human has not ratified it as a durable choice.

## Context

[ADR 0012](0012-meter-chat-completions-usage.md) makes Ox Alpha
(`x-preview-f-free`, served by opencode zen) a metered model, so its tokens now
reach the dashboard. Its cost does not: zen publishes no rate card, the model is
served from an undisclosed organization, and its responses report `"cost":"0"`
because it is currently a free tier.

Two existing commitments pull against inventing a number here.
`packages/core/src/pricing.ts` states that rates are never invented, and
[ADR 0003](0003-unavailable-incomplete-cost.md) requires that an unknown model
price as *unavailable* rather than as a wrong or partial estimate. Left alone,
Ox Alpha would show tokens with cost permanently unavailable.

The operator asked for Anthropic's Claude Fable 5 rates to stand in, to get a
sense of what the same traffic would cost at frontier prices.

## Decision

Price `x-preview-f-free` with Claude Fable 5's published rates, as a declared
stand-in:

| category | USD per million tokens |
| --- | --- |
| input | 10.00 |
| cached input | 1.00 |
| output | 50.00 |

Source: Anthropic's published Claude Fable 5 rate card
(<https://platform.claude.com/docs/en/about-claude/pricing>).

Fable's cache **write** rates — $12.50/MTok at 5 minutes and $20/MTok at one
hour — have no corresponding category in this model, which prices only input,
cached input, output, and reasoning output. They are deliberately not forced
into a category that would misreport them.

Because this entry's provenance differs from every other row, `source` and
`effectiveDate` become **per-entry** rather than catalogue-wide constants. The
existing OpenAI entries keep their exact values; only their provenance moves
from an implicit global to an explicit default.

## Consequences

- **These figures are not what anyone is billed.** Zen reports `"cost":"0"` for
  this model today, so the estimate models a hypothetical price for traffic that
  is currently free. Any dashboard total for Ox Alpha should be read that way.
- The rates belong to a different model from a different vendor. They are a
  reference point, not a measurement, and nothing downstream should treat them
  as authoritative.
- This is the first entry whose rates were not ported from codex-proxy, which is
  why it is recorded rather than assumed. `pricing.ts` no longer says rates are
  never invented without qualification; it now points here.
- Replace this entry with real rates the moment zen publishes them, or drop it
  and let cost read unavailable per ADR 0003 — that outcome is honest and
  remains the correct default for any model without a published price.
