---
type: adr
title: Pin Plane parity to one claude-proxy commit
description: Measure the final phase against a stable source capability inventory rather than a moving default branch.
tags: [product, roadmap, parity]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0008"
    file: docs/adrs/0008-pin-plane-parity.md
  - repo: ox-alpha-proxy
    number: "0008"
    file: docs/adrs/0008-pin-plane-parity.md
decided-by: /dev
ratified: false
needs-human: true
---

# Pin Plane parity to one claude-proxy commit

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "Is Plane parity measured against a pinned claude-proxy commit recorded in the roadmap,
> or against whatever its default branch contains when Plane begins?"

A moving default branch prevents a parity phase from having a testable finish. The
roadmap needs one immutable source inventory.

## Decision

Measure Plane against claude-proxy commit
`cc25696504e724bd78824e639e97a0a1d846abea`. Adapt applicable capabilities to OpenAI
Responses semantics, and record an explicit rationale for every non-applicable capability.

**A parity row closes only as `implemented` with evidence, or `N/A` with a rationale.
There is no third state.**

## Consequences

- Plane can use a finite, reviewable parity matrix, and has a testable finish.
- Later claude-proxy changes do not silently expand Plane.
- Moving the parity target requires superseding this decision.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0008-pin-plane-parity.md` (`codex#0008`) and
`ox-alpha-proxy` `docs/adrs/0008-pin-plane-parity.md` (`ox-alpha#0008`) during the
`monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated it on `2026-08-22`, citing the codex record and
confirming the pinned commit was present in the local claude-proxy checkout at charting
time.

**Governs the `codex` and `ox-alpha` stacks.** Both pin the identical commit, so there is
no per-stack variant to keep. ox-alpha-proxy added two clarifications, both kept in the
Decision above or here: that a row has no third state beyond `implemented` and `N/A`, and
that codex-proxy's own source is a mechanics reference where docs are silent — never a
parity target, since its own matrix was unresolved at the time.

**The pinned commit is now local.** `cc25696` is an ancestor of this repository's own
history rather than a reference into a separate one, which makes the parity inventory
readable without leaving the monorepo.

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
