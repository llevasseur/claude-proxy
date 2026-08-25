---
type: adr
title: An interrupted last node reads finished
description: An interrupted terminal node maps to Smiling, never ages into stress, and renders a stopped trigger line.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0023"
    file: docs/adrs/0023-an-interrupted-last-node-reads-finished.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 6
needs-human: true
---

# An interrupted last node reads finished

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> Where do the interruption flags fit the emotion state machine?

Every node carries `interrupted` and `interruption`; a deliberately stopped or timed-out run ends on neither `done` nor `error`, so the idea's carve-out missed the third way a run ends and would age it into Stressed.

## Decision

If the derived last node carries `interrupted`, the emotion is Smiling regardless of node type, exactly as `done` maps, and it never ages into stress. The trigger line renders "stopped · step <index> · <age> ago" with the node's text to roughly 80 characters, the same shape as a finished line.

## Consequences

All three ways a run ends — outcome, failure, interruption — are non-aging. The mapping adds an emotion route and a line form the original idea never named.
