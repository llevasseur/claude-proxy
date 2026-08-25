---
type: adr
title: Ox Alpha keeps its nested usage buckets, and the disjoint-bucket claim stays open
description: The inherited nested-bucket normalizer is preserved unchanged because a written contract and four load-bearing sites depend on it; the claim that ox's buckets are disjoint is recorded as an open question naming the one artifact that would settle it.
tags: [usage, providers, ox-alpha, pricing]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 4
needs-human: true
---

# Ox Alpha keeps its nested usage buckets, and the disjoint-bucket claim stays open

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it declines a rewrite an earlier brief proposed, and because
the question it leaves open can only be closed by evidence this repository does not
currently hold.

## Context

An earlier framing of this campaign held that Ox Alpha's usage buckets are three **disjoint**
input buckets, and that the inherited nested-bucket normalizer should be discarded — on the
warrant that `cached <= input` was a copying artifact inherited from codex rather than a
real property of Ox Alpha's wire format.

**That warrant is false**, and it was checked rather than assumed.

`docs/specs/ox-alpha-bike-architecture.md:42` states, under the shared domain contract:

> Detail is a subset of its headline category and never increases totals.

That is a written contract in this bundle, not an inference.

The nested assumption is load-bearing at four verified sites, **two of them arithmetic
that goes negative if the nesting is inverted**:

| Site | What it does |
|---|---|
| `stacks/ox-alpha/packages/core/src/usage.ts:50` | `if (cachedInputTokens > inputTokens)` — rejects at ingest |
| `stacks/ox-alpha/packages/core/src/sidecar.ts:147` | rejects a sidecar whose detail exceeds its headline total |
| `stacks/ox-alpha/packages/core/src/pricing.ts:89` | `['input', usage.inputTokens - usage.cachedInputTokens]` |
| `stacks/ox-alpha/packages/core/src/limits.ts:42` | `10 * (inputTokens - cachedInputTokens) + cachedInputTokens + 10 * outputTokens` |

The last two subtract cached from input. Under disjoint buckets both go negative.

`usage.ts:50-58` enforces three invariants at ingest — `cachedInputTokens <= inputTokens`,
`reasoningOutputTokens <= outputTokens`, and `totalTokens === inputTokens + outputTokens` —
raising a hard `UsageValidationError` otherwise.

**Neither piece of evidence that would settle the question exists here.** No captured
ox-alpha-proxy sidecar exists anywhere in this repository: the only log directory is
`stacks/claude/logs`, and every capture in it is `_anthropic.*`. And
[ADR 0035](0035-fable-standin-rates-for-ox-alpha.md) records Ox Alpha as served from an
undisclosed organization publishing no rate card, so "Ox Alpha's own API documentation"
cannot be cited either.

## Decision

**Ox Alpha keeps its inherited nested-bucket normalizer, unchanged.** It is not discarded,
and it is not rewritten to three disjoint input buckets.

**The disjoint-bucket claim is recorded here as an open question rather than settled in
either direction.** This record does not assert that ox's buckets are nested as a fact
about the vendor's wire format. It asserts that the nested reading is what this repository
has written down, what four sites depend on, and what the code enforces — and that no
evidence available here contradicts it.

**The asymmetry between providers is deliberate and is not a defect to normalise away.**
Anthropic's cache tokens are **additive** — separate addends outside `input_tokens`.
OpenAI's are a **subset** of input. Ox Alpha's are **nested** per the contract above. Each
ProviderAdapter owns its own reconciliation rule, and no rule leaks past its own provider's
boundary. That is the whole point of the seam this campaign extracts.

**The one artifact that would settle this: a captured ox-alpha-proxy sidecar.** One real
capture, showing whether `cachedInputTokens` exceeds `inputTokens` in the wild, closes the
question in whichever direction it points. Until one exists, this record stays open.

## Consequences

**Today, an unexpected ox usage shape throws `UsageValidationError` loudly.** That is the
behaviour being preserved, and preserving it is the substance of this decision rather than
a side effect. A permissive rewrite would **accept** such a shape and **price** it, so the
failure would move from a loud rejection at ingest into a silently wrong number in a cost
column — the same class of failure as
[ADR 0020](0020-unavailable-incomplete-cost.md)'s zero-instead-of-null, and the class this
campaign refuses in [ADR 0060](0060-a-stores-absence-is-typed.md) and
[ADR 0064](0064-tokens-do-not-aggregate-across-providers.md).

**A loud rejection is the correct behaviour under uncertainty.** If the disjoint reading
turns out to be right, the current code fails visibly on the first record that proves it,
which is exactly how this question gets answered. The permissive version would never
surface it.

- The four sites above are a **change-detector**: any future work touching them must
  re-read this record first.
- `docs/specs/ox-alpha-bike-architecture.md:42` is the governing contract, and changing the
  normalizer means amending that spec, not only the code.
- Because no canonical token schema exists (ADR 0064), ox's shape never has to be
  translated into a common one — which is what makes preserving it cost nothing at the seam.

## Alternatives considered

**Rewrite ox to three disjoint input buckets.** Rejected. It contradicts a written contract
in this bundle, breaks two arithmetic sites into negative numbers, and rests on a warrant
that is demonstrably false. It would also convert a loud failure into a silent mispricing.

**Relax the invariants to accept either shape.** Rejected for the same reason, and it is
strictly worse than either fixed choice: it accepts both readings, so it can never detect
which is right, and it prices whatever arrives.

**Assert the nested reading as settled fact.** Rejected as overclaiming. The evidence here
is a spec line and four dependent sites — strong grounds to preserve the behaviour, not
grounds to close a question about a third party's wire format that no artifact in this
repository can answer.
