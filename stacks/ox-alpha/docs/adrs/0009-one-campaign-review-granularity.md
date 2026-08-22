---
type: adr
title: Review one campaign at one closing pull request
description: Needs-human decisions ratify at the single closing PR; unwind risk is bounded by phase gates.
tags: [process, governance, review]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 3
needs-human: true
---

# Review one campaign at one closing pull request

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "When do the flagged needs-human decision records actually reach the human for ratification — before the campaign opens, at each phase-boundary blocking edge, or only at the single closing pull request?"

The run is unattended end to end and cannot block on a human mid-flight.

## Decision

Chart one continuous campaign for all four rungs. Encode each phase boundary as
a hard blocking edge: no later-phase wave opens until every earlier-phase ticket
has merged to the campaign base branch and its verify gate passes there. Flagged
unratified decisions bind provisionally and reach the human once, at the closing
pull request, whose body leads with the needs-human list.

## Consequences

- A human rejection unwinds forward work rather than steering it mid-run.
- Phase gates bound that blast radius: every rung stays independently useful and independently rebuildable.
- The closing PR body is the ratification surface, not a change summary.
