---
type: adr
title: Make incomplete cost unavailable
description: Never represent an unknown or partially priced request as a zero or complete estimate.
tags: [architecture, pricing, usage]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0003"
    file: docs/adrs/0003-unavailable-incomplete-cost.md
  - repo: ox-alpha-proxy
    number: "0003"
    file: docs/adrs/0003-unavailable-incomplete-cost.md
decided-by: /dev
ratified: false
---

# Make incomplete cost unavailable

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "What must Bike report when a model or usage category has no configured price: 'cost
> unavailable' while still showing tokens, or a partial/zero estimate?"

A zero or partial estimate looks complete in an aggregate and understates spend. Token
counts remain useful even when a catalogue lacks a required rate.

## Decision

Return the complete token metrics and mark the entire cost unavailable when the model or
any consumed usage category lacks a configured price. Include a typed reason. Never
substitute zero, and never label a partial estimate as total cost.

## Consequences

- Cost is nullable in sidecars, database rows, API summaries, and the UI.
- Aggregation propagates unavailability when any included request is not fully priced.
- The Overview renders an unavailable state instead of `$0`.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0003-unavailable-incomplete-cost.md` (`codex#0003`) and
`ox-alpha-proxy` `docs/adrs/0003-unavailable-incomplete-cost.md` (`ox-alpha#0003`) during
the `monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated it on `2026-08-22`, citing the codex record.

**Governs the `codex` and `ox-alpha` stacks.** This is the pair that agreed most closely
— the two Decision sections were already word-for-word identical, which is why the
merged statement needs no reconciliation. ox-alpha-proxy adds one note of its own, kept
here: its pricing rates are ported mechanics from the codex-proxy catalogue rather than
re-invented values.

**Neither source carried a `needs-human` flag, so this record carries none.** An absent
flag is preserved as absent rather than written out as `false` (ADR 0052).

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
