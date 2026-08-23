---
type: adr
title: Make incomplete cost unavailable
description: Never represent an unknown or partially priced request as a zero or complete estimate.
tags: [architecture, pricing, usage]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 4
---

# Make incomplete cost unavailable

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0003-unavailable-incomplete-cost.md`.
Pricing rates themselves are ported mechanics from the codex-proxy catalogue,
not re-invented values.

## Decision

Return the complete token metrics and mark the entire cost unavailable when the
model or any consumed usage category lacks a configured price. Include a typed
reason. Never substitute zero and never label a partial estimate as total cost.

## Consequences

- Cost is nullable in sidecars, database rows, API summaries, and the UI.
- Aggregation propagates unavailability when any included request is not fully priced.
- The Overview renders an unavailable state instead of `$0`.
