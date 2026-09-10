---
type: adr
title: The view toggle lives in the shared shell's header row
description: One slim header row above the rail-and-pane grid carries the Chat/Alive link pair on both pages.
tags: [dashboard, sessions, navigation]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0028"
    file: docs/adrs/0028-the-view-toggle-lives-in-the-shared-shell-header-row.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 11
needs-human: true
---

# The view toggle lives in the shared shell's header row

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> Where does each half of the toggle pair actually live, given that "/sessions/alive" has no existing controls and "/sessions"' controls belong to components this phase otherwise leaves byte-identical?

The sessions page's furniture sits inside `ChatConversation`'s footExtras and `SessionsSidenav`'s footer; `/sessions/alive` has no chat footer at all.

## Decision

The shared shell extracted from the sessions page wraps the rail-and-pane layout and renders one slim header row above it holding the link pair — Chat to `/sessions`, Alive to `/sessions/alive` — with the current route's own link inert. Both halves exist on both pages. Nothing inside `ChatConversation` or `SessionsSidenav` changes for this concern; the sidenav's only edit remains the optional `onSelect` prop.

## Consequences

The scope's "beside the sessions page's existing controls" becomes "in the shared shell's header row above them". The extraction now means: sidenav slot, QueryState wrapper, and this header row.
