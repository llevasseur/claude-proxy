---
type: adr
title: The alive view's empty state explains itself
description: With nothing watched, /sessions/alive renders Smiling over "nothing active · select a session in the rail" and issues no fetches.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0025"
    file: docs/adrs/0025-the-alive-views-empty-state-explains-itself.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 8
needs-human: false
---

# The alive view's empty state explains itself

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> What does `/sessions/alive` render when there is no watched session at all — a freshly opened tab where no chat has been started?

The tab-owned thread is undefined until a chat starts; the idea's only empty rule ("no nodes → Smiling") presupposes a watched transcript.

## Decision

With no watched id, render the muted register the rail already uses for emptiness: emotion word Smiling, trigger line "nothing active · select a session in the rail". Disable the nodes query (`enabled: false`) and open no stream — there is no id to watch. The toggle stays reachable.

## Consequences

The first screen a curious operator sees explains itself instead of deriving an emotion from absent data.
