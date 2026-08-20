---
type: adr
title: Pin Plane parity to one claude-proxy commit
description: Measure the final phase against a stable source capability inventory.
tags: [product, roadmap, parity]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 12
needs-human: true
---

# Pin Plane parity to one claude-proxy commit

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Is Plane parity measured against a pinned claude-proxy commit recorded in the roadmap, or against whatever its default branch contains when Plane begins?”

A moving default branch prevents a parity phase from having a testable finish.
The roadmap needs one immutable source inventory.

## Decision

Measure Plane against claude-proxy commit
`cc25696504e724bd78824e639e97a0a1d846abea`. Adapt applicable capabilities to
OpenAI Responses semantics and record an explicit rationale for every
non-applicable capability.

## Consequences

- Plane can use a finite, reviewable parity matrix.
- Later claude-proxy changes do not silently expand Plane.
- Moving the parity target requires superseding this decision.
