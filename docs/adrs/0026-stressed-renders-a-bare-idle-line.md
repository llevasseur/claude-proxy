---
type: adr
title: Stressed renders a bare idle line
description: The Stressed trigger line is only "idle for Xm"; the general step-index grammar covers every other state.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0026"
    file: docs/adrs/0026-stressed-renders-a-bare-idle-line.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 9
needs-human: false
---

# Stressed renders a bare idle line

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> What exactly does the Stressed trigger line render? Your amendments now state two incompatible forms.

The general grammar promised "<emotion> · step <index> · <age> ago" always; the idea's stressed sentence said "renders only `idle for Xm`".

## Decision

The specific sentence wins. The general form applies to Smiling, Thinking, Disgruntled and the stopped line; Stressed renders only "idle for Xm", where Xm is elapsed since the newest family transcript's last append. A step index pointing at a long-stale node is noise when the one fact needed is how long it has sat.

## Consequences

The scope line's "always showing step index and relative timestamp" holds for the non-stressed states only.
