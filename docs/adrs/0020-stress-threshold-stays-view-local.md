---
type: adr
title: Stress threshold stays view-local at 30 minutes
description: The alive view derives Stressed from a local 30-minute constant rather than consuming the server liveness verdict.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0020"
    file: docs/adrs/0020-stress-threshold-stays-view-local.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 3
needs-human: true
---

# Stress threshold stays view-local at 30 minutes

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> Why does the view invent a second, client-side staleness verdict ("Stressed", 30 min, local constant) instead of consuming the server-computed `liveness` verdict that the amended read path already delivers on every poll?

The graph index already carries `liveness` (`running` / `quiet` / `finished` / `unknown`) with a deliberate ten-minute quiet window, and `docs/features/live-session-graph.md` argues staleness thresholds belong on the server where they can be argued with.

## Decision

Keep the idea's rule verbatim: the view holds a named local constant (30 minutes) and reads `modified`, deriving Stressed only when the raw derivation would be Thinking. `liveness` remains the sole authority for its own pages; this view answers a different question — an agent sitting mid-thought for half an hour — from the same field, so no second source of truth for staleness exists.

## Consequences

This contradicts the feature doc's generalisation that such thresholds live on the server. The threshold cannot be argued with from a payload. A human should either ratify the split or move the verdict server-side in a later phase.
