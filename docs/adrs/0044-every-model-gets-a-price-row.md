---
type: adr
title: "Cost semantics: every model gets a price row"
description: Per-proxy fallback rates stamped with their source, unknown models priced null rather than zero, and one current rate per model with no effective dating.
tags: [monorepo, pricing, cost, architecture, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# Cost semantics: every model gets a price row

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

Settles the disagreement between claude-proxy's `FALLBACK_PRICE` and codex/ox's blanket ban
on inventing rates ([0020](0020-unavailable-incomplete-cost.md)) by taking neither.

## Context

The three stacks priced traffic three ways. claude-proxy carried a `FALLBACK_PRICE` applied
to anything not in the catalogue, which produces a number for every record and makes an
invented rate indistinguishable from a published one. codex and ox took the opposite line
in 0020 — never invent a rate, mark the whole cost unavailable — which is honest and leaves
a large share of the corpus with no cost at all, so aggregates read as though that traffic
were free or absent.

[0038](0038-retroactive-catalogue-pricing.md) had already established that history reprices
against the current catalogue rather than being frozen at capture time.

## Decision

**Every model gets a price row.** Pricing is not a lookup that can miss; it is a table with
a row for every model the corpus contains.

**Each proxy declares its own fallback.** There is no repository-wide fallback rate, because
a rate that would be defensible for one provider is not defensible for another. A record
priced by a fallback is **stamped with its source**: `pricing_source: fallback:<proxy>`.
The stamp is the whole point — a fallback-priced number is usable in an aggregate *and*
identifiable as an estimate, which neither of the two prior positions allowed.

**A model with no defensible rate is `unknown`, and its cost is `null` — never `0`.** This
is the part of 0020 that survives intact and is the one line here that must not be softened.
Zero is a number, it aggregates, and it silently understates spend; `null` propagates as
unavailable and cannot be mistaken for free traffic. A free tier that genuinely costs
nothing is a rate of zero in its price row, which is a different fact recorded a different
way.

**Rates are a table, with a dashboard CRUD page.** Not a constant in source, not a JSON file
edited by hand. The operator adds and edits rates in the dashboard.

**No effective dating.** One current rate per model prices every row in the corpus, and
editing a rate reprices the corpus. There is no `valid_from`, no rate history, and no
as-of-date resolution. The dashboard answers "what would this traffic cost at today's
rates", not "what was billed at the time", and building the second is a schema and a query
surface that the first does not need.

## Consequences

- Cost is nullable everywhere it appears — sidecars, database rows, API summaries, the UI —
  and an aggregate containing any unpriced record reports unavailability rather than a
  partial total.
- Every priced record carries `pricing_source`, so the dashboard can show what share of a
  total rests on fallback rates rather than published ones.
- Editing a rate changes historical numbers. That is intended and is a visible consequence
  the CRUD page states at the point of editing, because an operator correcting a typo will
  see last month's totals move.
- Reproducing a past invoice from this dashboard is out of scope. Anyone who needs that
  needs effective dating, which is a new decision superseding this one rather than an
  addition to it.
- [0035](0035-fable-standin-rates-for-ox-alpha.md)'s stand-in rates fit this shape directly:
  a declared borrowed rate is a price row with a source stamp.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
