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
| 03 | alive-route-page | [alive-view-mote-03-alive-route-page](alive-view-mote-03-alive-route-page.md) | `task/alive-view-mote-03-alive-route-page` | todo |

Dependencies: 03 depends on 01 and 02; 01 and 02 are independent.

## Completed

<!-- newest first; one entry appended per task completion -->

### 02 — core-emotion-derivation (2026-08-25)

PR [#304](https://github.com/llevasseur/claude-proxy/pull/304), squash-merged into
`wayfinder/alive-view-mote`. `stacks/claude/core/src/alive-view.ts`
is the pure derivation: newest-`modified` family transcript picks the last merged node and the
last-append clock (ADR 0022); `done`, an interrupted last step and empty inputs read Smiling,
`error` reads Disgruntled, mid-run reads Thinking, and only Thinking ages into Stressed past
`STRESS_THRESHOLD_MS` (ADR 0023). Trigger lines carry the bare "idle for Xm" stressed form and
the general "`<lead>` · step `<index>` · `<age>`m ago" form, with per-type leads — tool call
head, error blaming its tool or its own truncated text (ADR 0024), `stopped` for a cut-off run.
Deviations worth keeping: the plan left the exact line assembly open, so decision/done lines
lead with the emotion word plus the node's text and a toolless signature renders as name only;
and the input accepts either a caller-merged stream or the raw transcript/derived pair, since
`mergeSessionNodes` keeps the transcript's length and ticket 03 polls the already-merged shape.
The workspace `test` gate flakes on this machine under load (ox-admin css hook timeout, server
chat-cli timings, a route-methods random-port collision with a live process on 8807); each passes
in isolation, CI green after one flake rerun.

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
