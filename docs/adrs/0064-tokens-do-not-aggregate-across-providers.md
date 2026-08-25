---
type: adr
title: Tokens do not aggregate across providers
description: A cross-provider view shows side-by-side token series keyed by provider and never a single summed line; any all-provider scalar is money only, where a common unit and a propagation rule already exist.
tags: [usage, providers, dashboard, aggregates]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 4
needs-human: true
---

# Tokens do not aggregate across providers

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it is product-visible: it forbids a "total tokens, all
providers" figure anywhere in the dashboard, which someone will eventually ask for.

## Context

The campaign builds a reader-side fan-out over three provider stores. The griller asked
what that fan-out is permitted to *combine*:

> "The fan-out-and-merge machinery exists to serve cross-provider pages, but the corpus
> defines a cross-provider aggregate for exactly one quantity — money.
> `docs/adrs/0044-every-model-gets-a-price-row.md` gives cost a common unit and a
> propagation rule (`null` propagates; any unpriced record makes the aggregate
> unavailable). **Tokens have no common unit here, and nothing in the corpus supplies
> one.** ... So 'total tokens today, all providers' is three different measurements added
> together, and — unlike an unpriced cost — the result is a plausible-looking number with
> no typed reason attached."

The three measurements really are different, and the difference is recorded rather than
suspected:

- **Anthropic** — cache-read and cache-creation are **additive**, separate addends outside
  `input_tokens`.
- **OpenAI** — cached input is a **subset** of input.
- **Ox Alpha** — detail is **nested** inside its headline category, per
  `docs/specs/ox-alpha-bike-architecture.md:42`, and
  `stacks/ox-alpha/packages/core/src/usage.ts:50-58` enforces
  `totalTokens === inputTokens + outputTokens` with a hard `UsageValidationError`.

## Decision

**Cross-provider pages never sum tokens.**

- A cross-provider token view is **side-by-side series keyed by provider** — three series,
  three legends, three provider labels — and never a single summed line.
- **Any "all providers" scalar is money only**, where
  [ADR 0044](0044-every-model-gets-a-price-row.md) already governs both the unit and the
  propagation rule: `null` propagates, and one unpriced record makes the aggregate
  unavailable.
- **Within one provider, tokens sum freely**, using that provider's own semantics. The
  ProviderAdapter owns its reconciliation rule and no rule leaks past its own provider's
  boundary.
- **There is no canonical normalized token schema**, and no adapter method returns one.

### Why money aggregates and tokens do not

0044 gives cost two things that make a cross-provider total meaningful: **a single unit**,
and **a defined answer for a contributor that cannot be expressed in it**. The corpus
supplies neither for tokens. Adopting both silently inside a fan-out reader would not be a
merge detail — it would be a new measurement standard adopted by implication.

And it would be the worst-behaved kind of absence. An unpriced cost surfaces as `null` with
a typed reason, so it is legible. A summed token line across three providers surfaces as a
**plausible integer with nothing attached to it** — no null, no reason, and no way for a
reader to know the three addends were measured differently. That is the failure
[ADR 0060](0060-a-stores-absence-is-typed.md) refuses, arriving through a different door.

### What this record does not lean on

[ADR 0040](0040-three-providers-and-three-harnesses.md) declines to fuse the two *axes* —
provider and harness — and says nothing about fusing the *measurements*. It is not cited as
governing here. Stretching a ratified record to cover a question it does not address is
precisely the move this campaign has avoided elsewhere.

## Consequences

- **No dashboard surface may display a cross-provider token total.** This is a constraint on
  every page, not only on the ones that exist today.
- **Comparison across providers is visual, not arithmetic.** Three series on one chart is
  permitted and useful; one line summing them is not.
- **A future common token unit is a new decision superseding this one**, not an extension of
  it. It would have to define the unit, the mapping from each provider's counters, and the
  answer for a record that cannot be expressed — the three things absent today.
- Per-provider totals remain fully available and are the honest form of the question.

## Alternatives considered

**A canonical normalized token schema every ProviderAdapter maps into.** Rejected, and it
fails on its own terms rather than on preference. It forces ox's
`totalTokens === inputTokens + outputTokens` assertion at `usage.ts:50-58` to be either
**preserved** — in which case ox cannot be expressed in the canonical schema and the scheme
fails — or **relaxed**, which is the disjoint-bucket rewrite
[ADR 0063](0063-ox-alpha-keeps-its-nested-usage-buckets.md) refuses, converting a loud
`UsageValidationError` into a silently accepted and then priced shape. So it arrives at a
destination already rejected, by a longer route.

**Sum the tokens and footnote the caveat.** Rejected. A footnote does not travel with a
number into a screenshot, an export, or a memory. The corpus's consistent answer to "this
value may mislead" is a typed absence, not an annotation.
