---
type: adr
title: Trigger-line age is last-append age
description: The alive view's relative timestamp measures elapsed since the transcript's last append, never since the step.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0019"
    file: docs/adrs/0019-trigger-line-age-is-last-append-age.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 2
needs-human: false
---

# Trigger-line age is last-append age

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> What is the trigger line's relative timestamp ("· 2m ago") actually measured from, given that no node carries a time?

`SessionNode` carries no per-step time and `docs/features/live-session-graph.md` states individual transcript lines carry no timestamps. Only transcript-level clocks exist: `SessionDetail.modified` and the graph index's `modified`.

## Decision

"Xm ago" means elapsed since the watched transcript's last append, computed from `modified` at render — the same field and clock that drives the stress rule. The line describes the transcript's recency, never the step's. Tickets are written so they cannot promise per-step recency.

## Consequences

During a long in-flight turn the displayed age grows against the newest step. No alternative exists without backend changes, which the phase forbids.
