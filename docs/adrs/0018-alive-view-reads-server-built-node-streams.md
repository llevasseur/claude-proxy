---
type: adr
title: Alive view reads server-built node streams
description: The /sessions/alive emotion derives from graph node streams polled as the session-graph page polls them; SSE carries only SessionDetail freshness.
tags: [architecture, dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0018"
    file: docs/adrs/0018-alive-view-reads-server-built-node-streams.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 1
needs-human: true
---

# Alive view reads server-built node streams

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> What does the view actually parse, given that `/api/sessions/session/stream` delivers transcript *markdown*, not nodes?

The original idea told the view to subscribe to `/api/sessions/session/stream` and run `mergeSessionNodes` over it. That stream re-emits `SessionDetail` whose `content` is raw markdown (`stacks/claude/admin/src/api.ts`, the paired one-shot endpoint), while `mergeSessionNodes` takes two parsed node arrays. Parsing markdown in the browser is already refused by `docs/features/live-session-graph.md`: "The browser never parses raw Markdown."

## Decision

Derive the emotion from the same server-produced node streams the session-graph page consumes: poll `/api/sessions/graph/nodes` for the watched family exactly as `session-graph.tsx` does, and run `mergeSessionNodes` over its already-parsed arrays. Subscribe to `/api/sessions/session/stream` with `useLiveQuery` only to keep `SessionDetail.modified` fresh between polls; if implementation shows the poll already delivers that freshness, the subscription may be dropped rather than kept as decoration.

## Consequences

Zero backend code changes still hold — both read paths exist. The idea's "updated over the existing SSE streams" weakens to "updated at the graph page's poll cadence"; a human may prefer restoring an SSE node stream on the server in a later phase.
