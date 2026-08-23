---
type: adr
title: Fix the Bike-to-Plane outcome ladder
description: Deliver five independently useful outcomes in a stable order with copy-ready continuation prompts.
tags: [product, roadmap, incremental-delivery]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 5
needs-human: true
---

# Fix the Bike-to-Plane outcome ladder

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Should the durable roadmap commit to this fixed, outcome-based ladder: Bike (live token/cost overview), Car (history, trends, and model/range filtering), Boat (opt-in body capture plus context/tool/session inspection), Train (operator workflows, automation, and coaching), then Plane (complete capability and operational parity)?”

The product needs an incremental path where every phase reaches the destination
on its own. A feature inventory without phase outcomes would allow later scope to
leak into Bike.

## Decision

Fix the delivery order as Bike, Car, Boat, Train, then Plane. Define each phase
as an independently useful outcome and include copy-ready `$dev` prompts that
advance one phase while preserving every earlier one.

## Consequences

- Bike remains one live overview instead of a reduced copy of every final page.
- Each later phase has a stable scope boundary and named exclusions.
- Changing the order or meaning of a phase requires superseding this record.
