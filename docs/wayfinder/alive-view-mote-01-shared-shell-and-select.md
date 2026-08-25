---
type: wayfinder-plan
title: Alive View 01 — shared sessions shell and rail selection
description: Extract the shell /sessions and /sessions/alive share, add the optional onSelect prop to SessionsSidenav, and render the Chat/Alive toggle row.
tags: [wayfinder, dashboard, sessions]
timestamp: 2026-08-25
scope: claude
campaign: alive-view-mote
number: "01"
---

# Alive View 01 — shared sessions shell and rail selection

Branch: `task/alive-view-mote-01-shared-shell-and-select`, cut from `wayfinder/alive-view-mote`.
Lane: `stacks/claude/admin/src/routes/sessions.tsx`, `stacks/claude/admin/src/components/SessionsSidenav.tsx`, one new component file under `stacks/claude/admin/src/components/`. Touch nothing else in `apps` or other stacks' trees.

## Criteria

1. Extract a shared shell component from `SessionsPage` (`stacks/claude/admin/src/routes/sessions.tsx`) holding: the rail slot (the `QueryState` wrapper with the skeleton fallback), the sidenav placement, and a slim header row above the rail-and-pane grid carrying the link pair Chat → `/sessions` and Alive → `/sessions/alive`, current route's own link rendered inert/highlighted. Per ADR 0028.
2. Both `/sessions` and `/sessions/alive` render through this shell. `/sessions/alive` may be a placeholder page in this ticket if ticket 03 has not merged — but only if it does not register a conflicting route; prefer landing the shell change without the second route and letting ticket 03 add the route file.
3. `SessionsSidenav` gains exactly one optional prop, `onSelect?: (threadId: string) => void`. Absent it, rows render `<Link to='/sessions/$id'>` byte-for-byte as today. Present, rows render as buttons calling it. Per ADR 0021.
4. `/sessions` behaviour is otherwise unchanged: no visual regression beyond the added header row, no prop reshuffles in `ChatConversation`, no edits inside its footExtras.
5. Header-row styling uses existing tokens (`stacks/claude/admin/src/styles/tokens.css`) — `var(--space-N)` steps, no bare px. Standard transitions only.
6. `pnpm --filter @agent-proxy/claude-admin typecheck` passes; `biome check` passes repo-wide; admin has no test suite (typecheck is its gate).

## Verification

`my-command-tools verify` green on this branch. Manual check optional: both links navigate, inert styling follows the route.
