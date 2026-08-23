---
type: adr
title: Pin Plane parity to one claude-proxy commit
description: Measure the final phase against a stable source capability inventory.
tags: [product, roadmap, parity]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 9
---

# Pin Plane parity to one claude-proxy commit

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0008-pin-plane-parity.md`. The pinned
commit is unchanged and was verified present in the local `claude-proxy`
checkout at charting time.

## Decision

Measure Plane against claude-proxy commit
`cc25696504e724bd78824e639e97a0a1d846abea`. Adapt applicable capabilities to
OpenAI Responses semantics and record an explicit rationale for every
non-applicable capability. A row closes only as `implemented` with evidence or
`N/A` with a rationale; there is no third state. codex-proxy's current source is
a mechanics reference where docs are silent (see root `AGENTS.md`) and never a
parity target — its own matrix is unresolved today.

## Consequences

- Plane can use a finite, reviewable parity matrix and has a testable finish.
- Later claude-proxy changes do not silently expand Plane.
- Moving the parity target requires superseding this decision.
