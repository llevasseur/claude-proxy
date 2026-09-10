---
type: adr
title: Alive view derives from the newest family transcript
description: The emotion describes the whole agent run; the watched family's newest-modified transcript supplies the last node and the staleness clock.
tags: [dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0022"
    file: docs/adrs/0022-alive-view-derives-from-newest-family-transcript.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 5
needs-human: true
---

# Alive view derives from the newest family transcript

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> When the watched session fans out subagents, whose activity does the emotion describe — and does "Stressed" then lie?

A subagent writes as a separate transcript under the parent's session, so during a fan-out the parent's own transcript goes quiet — top-level-only derivation would read Stressed while branches run.

## Decision

Among the family transcripts `getSessionGraphNodes` already returns, pick the one whose `modified` is newest; derive the emotion from that transcript's last merged node and run the staleness clock against that same field. A quiet finished parent beside running branches still reads Thinking off the branch, which is correct.

## Consequences

"The LAST node" now means "the newest family transcript's last node", not the selected thread's. During fan-out the trigger line names whichever branch is appending, which may disorient an operator expecting the parent thread's steps.
