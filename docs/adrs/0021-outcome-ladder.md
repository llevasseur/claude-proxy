---
type: adr
title: Fix the outcome ladder, five rungs for codex and four for ox-alpha
description: Deliver independently useful outcomes in a stable order; the rung count is scoped per stack rather than shared.
tags: [product, roadmap, incremental-delivery]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0004"
    file: docs/adrs/0004-fixed-outcome-ladder.md
  - repo: ox-alpha-proxy
    number: "0004"
    file: docs/adrs/0004-four-rung-outcome-ladder.md
decided-by: /dev
ratified: false
needs-human: true
---

# Fix the outcome ladder, five rungs for codex and four for ox-alpha

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

Both stacks needed an incremental path where every phase reaches the destination on its
own. A feature inventory without phase outcomes would allow later scope to leak into
Bike.

The two repositories answered that need with **different rung counts**, and this record
is the reason the flat corpus can hold both without contradicting itself. codex-proxy
fixed five rungs. ox-alpha-proxy was asked directly whether Train was deliberately
dropped or accidentally omitted:

> "Is Train deliberately dropped in ox-alpha-proxy … or was omitting it accidental and
> the new repo follows the full five-rung ladder Bike → Car → Boat → Train → Plane as
> fixed in codex-proxy's ADR 0004?"

The human's instruction there enumerated exactly `bike, car, boat, plane`. Boat is named,
so the omission of Train is deliberate naming rather than shorthand.

## Decision

**Fix the delivery order as an outcome ladder. Define each phase as an independently
useful outcome, and include copy-ready `$dev` prompts that advance one phase while
preserving every earlier one.**

**The rung count is scoped per stack:**

| Stack | Ladder | Train |
|---|---|---|
| `codex` | Bike → Car → Boat → Train → Plane | included |
| `ox-alpha` | Bike → Car → Boat → Plane | deliberately closed |

For `ox-alpha`, every Train-dependent Plane parity row closes as `N/A` with a rationale
citing this record — never silently dropped, and never parked in a third `deferred`
state.

**These are two scoped instantiations of one decision, not a contradiction.** That
distinction is the whole reason the `scope` field exists in this bundle: a five-rung
ladder for codex and a four-rung ladder for ox-alpha are both true, of different stacks,
at the same time.

## Consequences

- Bike remains one live overview instead of a reduced copy of every final page.
- Each rung reaches the destination on its own, and each later rung preserves every
  earlier one.
- Each later phase has a stable scope boundary and named exclusions.
- On `ox-alpha`, Train's operator surfaces — automation, daily summaries, suggestions,
  coaching, recovery, maintenance — have no phase that builds them.
- Changing the order or meaning of a phase requires superseding this record. Restoring
  Train to `ox-alpha` requires the same, and reopens the affected parity rows as its
  tickets.

## Provenance

**One decision, instantiated differently by two repositories, restated here once.**
Merged from `codex-proxy` `docs/adrs/0004-fixed-outcome-ladder.md` (`codex#0004`) and
`ox-alpha-proxy` `docs/adrs/0004-four-rung-outcome-ladder.md` (`ox-alpha#0004`) during the
`monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy decided its own rung count on `2026-08-22`.

**Governs the `codex` and `ox-alpha` stacks, with the per-stack difference stated in the
Decision above rather than resolved away.** This pair is the one the merge could most
easily have damaged: collapsing five rungs and four into a single number would have
invented a decision neither repository made. Merging the pair means stating the shared
rule once and naming both instantiations — which is exactly what ADR 0053's Provenance
section anticipated when it said the two ladders are two scoped decisions rather than a
contradiction.

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
