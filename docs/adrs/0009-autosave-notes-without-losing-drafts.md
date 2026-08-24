---
type: adr
title: Autosave notes without losing drafts
description: Debounce note saves, retain failed drafts, and reorder notes only after successful content commits.
tags: [architecture, notes, dashboard, autosave]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0009"
    file: docs/adrs/0009-autosave-notes-without-losing-drafts.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 3
needs-human: true
---

# Autosave notes without losing drafts

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> the dashboard spec requires server failures to be rendered clearly, and round 1 makes a stale save rejectable: should the human editor autosave after a debounce while retaining unsaved local text on network/conflict errors, or require an explicit Save action; and, for the chosen behavior, what event alone advances `updatedAt` and therefore moves a note to the top?

Autosave reduces editing friction, but only if rejected writes remain visible and recoverable in the client.

## Decision

Debounce autosave and show explicit save state. Retain the local draft after network and conflict errors. Only a successful commit that changes the title or body advances `updatedAt`. Reads, no-op updates, failed updates, archive, and restore do not advance it.

## Consequences

The list reflects durable edits instead of keystrokes or lifecycle actions. The dashboard needs durable in-memory draft and conflict states.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
