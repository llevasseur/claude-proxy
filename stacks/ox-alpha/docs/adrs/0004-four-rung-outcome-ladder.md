---
type: adr
title: Fix the four-rung outcome ladder
description: Deliver four independently useful outcomes — Bike, Car, Boat, Plane — with Train deliberately closed.
tags: [product, roadmap, incremental-delivery]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 1
needs-human: true
---

# Fix the four-rung outcome ladder

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "Is Train deliberately dropped in ox-alpha-proxy (meaning ADR 0004 must be re-decided for the new repo and roughly ten Plane parity matrix rows re-scoped as N/A or absorbed elsewhere), or was omitting it accidental and the new repo follows the full five-rung ladder Bike → Car → Boat → Train → Plane as fixed in codex-proxy's ADR 0004?"

The human's instruction enumerates exactly `bike, car, boat, plane`. Boat is
named, so the omission of Train is deliberate naming rather than shorthand.

## Decision

Fix the delivery order as Bike, Car, Boat, then Plane. Define each phase as an
independently useful outcome. Close every Train-dependent Plane parity row as
`N/A` with a rationale citing this record — never silently dropped and never
parked in a third `deferred` state (see ADR 0008).

## Consequences

- Each rung reaches the destination on its own; each later rung preserves every earlier one.
- Train's operator surfaces (automation, daily summaries, suggestions, coaching,
  recovery, maintenance) have no phase that builds them.
- Restoring Train requires superseding this record, which reopens the affected
  parity rows as its tickets.
