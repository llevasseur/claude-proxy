---
type: adr
title: A toolless error renders its own text
description: An error last node with no tool renders "error · <node text>" truncated to about 80 characters.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0024"
    file: docs/adrs/0024-a-toolless-error-renders-its-own-text.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 7
needs-human: false
---

# A toolless error renders its own text

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> When an errored last node carries no tool (`tool: null`), what does "error · \<tool\> failed" render?

On an `error` node `tool` holds the nearest preceding tool call, else null — the parser documents that null happens. The node's own `text` carries the distilled error line.

## Decision

With a tool, the line stays exactly "error · <tool> failed". Without one, it renders "error · <node text to ~80 chars>", reusing the decision/done truncation mechanic. No blank slot and never the literal "null".

## Consequences

None beyond the view: one fallback form completes the spec's own sentence.
