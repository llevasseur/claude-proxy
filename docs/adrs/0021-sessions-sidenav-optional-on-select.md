---
type: adr
title: SessionsSidenav grows an optional onSelect prop
description: With onSelect present the rail rows select in place; absent it they link to transcripts exactly as today.
tags: [dashboard, sessions, components]
timestamp: 2026-08-25
scope: claude
provenance:
  - repo: claude-proxy
    number: "0021"
    file: docs/adrs/0021-sessions-sidenav-optional-on-select.md
decided-by: /dev
ratified: false
wayfinder: alive-view-mote
grill-round: 4
needs-human: true
---

# SessionsSidenav grows an optional onSelect prop

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> What should selecting a session in the rail actually do on `/sessions/alive`, given that today's rail rows are links that *navigate away* rather than swap anything?

Every rail row renders `<Link to='/sessions/$id'>`; on `/sessions` the only active id is the thread this tab's chat runs in, not a selection the pane follows.

## Decision

Add one optional prop, `onSelect?: (threadId: string) => void`. Absent it, rows render exactly as today. Present — on `/sessions/alive` only — rows render as buttons calling it instead of linking out. The alive view keeps its watched id in local state initialised to the tab-owned thread (`useChatSession` + `useChatThread`), so the default watch matches the chat pane's.

## Consequences

One shared sidenav survives with a single extension point; the chat page's behaviour is unchanged. A public component interface is committed and may want renaming or reshaping when a third consumer appears.
