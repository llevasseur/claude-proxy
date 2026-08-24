---
type: adr
title: Preserve note selection during live updates
description: Keep the current note and draft stable when polling or agent writes change recency order.
tags: [architecture, notes, dashboard, live-updates]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0013"
    file: docs/adrs/0013-preserve-note-selection-during-live-updates.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 7
needs-human: true
---

# Preserve note selection during live updates

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> when polling discovers that an MCP agent edited a different note and moved it to the top, should the UI preserve the human’s currently selected note and unsaved draft, using “open newest” only on initial entry or after the selected note disappears?

Agent writes can reorder the sidebar at any time. Following the first item would interrupt human work and risk hiding a draft.

## Decision

Never change selection merely because list order changed. Open the newest note only on initial entry without an explicit id. Preserve a dirty draft and show a banner if the selected note disappears.

## Consequences

The URL and selected id, not list position, define editor identity. Live updates can reorder discovery results without stealing focus.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
