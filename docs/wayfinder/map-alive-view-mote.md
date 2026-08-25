---
type: wayfinder-map
title: Wayfinder — Alive View on the sessions tab
description: A text-only live emotion line for watched agent sessions, shipped as three tickets off one base branch.
tags: [wayfinder, dashboard, sessions, live]
timestamp: 2026-08-25
scope: claude
slug: alive-view-mote
---

# Wayfinder — Alive View

**Slug:** `alive-view-mote`
**Base branch:** `wayfinder/alive-view-mote` (cut from `main`; every ticket targets it)
**Plans directory:** `docs/wayfinder/`
**Started:** 2026-08-25
**Goal:** Ship a text-only live "Alive View" at `/sessions/alive` — an emotion word plus a trigger line derived from server-built node streams — toggled against the chat view with zero backend changes.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature and spec docs.

Decisions this campaign made are recorded as `docs/adrs/0018`–`0028`, decided by `/dev`,
unratified; six carry `needs-human: true`.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 02 | core-emotion-derivation | [alive-view-mote-02-core-emotion-derivation](alive-view-mote-02-core-emotion-derivation.md) | `task/alive-view-mote-02-core-emotion-derivation` | in-progress | |
| 03 | alive-route-page | [alive-view-mote-03-alive-route-page](alive-view-mote-03-alive-route-page.md) | `task/alive-view-mote-03-alive-route-page` | todo |

Dependencies: 03 depends on 01 and 02; 01 and 02 are independent.

## Completed

<!-- newest first; one entry appended per task completion -->

### 01 — shared-shell-and-select (2026-08-25)

PR [#303](https://github.com/llevasseur/claude-proxy/pull/303), squash-merged into
`wayfinder/alive-view-mote`. `SessionsShell.tsx` now holds what `/sessions` built inline — the
`QueryState`-framed transcript rail with its skeleton (moved out of `sessions.tsx`) and a slim
Chat/Alive view switch above the rail-and-pane grid, per ADR 0028 — and `SessionsSidenav` grew
its one optional prop, `onSelect?` (ADR 0021): absent it rows render today's `<Link>` unchanged,
present it they render as buttons handing over the thread id. Deviations worth keeping: the
Alive tab ships **inert** — typed links cannot name the unregistered `/sessions/alive`, and
registering that route is ticket 03's work, so ticket 03 flips one span into a `Link`; and the
header row is styled inline against existing tokens because the stylesheet sits outside the
ticket's lane. The ox-alpha admin CSS test timed out under machine load during verify but passes
standalone; unrelated to this lane.

## Agent kickoff prompt

Read the repository's AGENTS.md, the wayfinder workflow, and
`docs/wayfinder/map-alive-view-mote.md`. Inspect live Git and worktree state.
Execute the next unblocked active task by running the task workflow against its
plan with `wayfinder/alive-view-mote` as the base branch; retarget the resulting
pull request to that base branch; stop after opening it.
