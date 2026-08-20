---
type: wayfinder
title: Wayfinder — Bike release
description: Ship the smallest complete codex-proxy with live token and cost visibility.
tags: [planning, bike]
timestamp: 2026-08-19
---

# Wayfinder — Bike release

**Slug:** `bike-release`
**Base branch:** `wayfinder/bike-release` (cut from the default branch; every ticket targets it)
**Plans directory:** `docs/plans/`
**Started:** 2026-08-19
**Goal:** Ship a private, clone-and-run Bike release that transparently proxies Codex traffic and shows today's live input tokens, output tokens, and cost.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature, spec, roadmap, and decision docs.

## Delivery waves

1. Build the repository foundation, pure usage core, and durable roadmap.
2. Build the proxy and server in parallel against the core contract.
3. Build and visually verify the Overview dashboard against the server API.

The owned paths in the four plans are disjoint. A ticket MUST NOT edit another
ticket's owned paths. If a shared contract needs to change, update task 01 first
and rebase its dependants before dispatch.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 01 | foundation-core-roadmap | [bike-release-01-foundation-core-roadmap.md](bike-release-01-foundation-core-roadmap.md) | `task/bike-release-01-foundation-core-roadmap` | todo |
| 02 | transparent-proxy | [bike-release-02-transparent-proxy.md](bike-release-02-transparent-proxy.md) | `task/bike-release-02-transparent-proxy` | todo |
| 03 | live-usage-server | [bike-release-03-live-usage-server.md](bike-release-03-live-usage-server.md) | `task/bike-release-03-live-usage-server` | todo |
| 04 | overview-dashboard | [bike-release-04-overview-dashboard.md](bike-release-04-overview-dashboard.md) | `task/bike-release-04-overview-dashboard` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

## Agent kickoff prompt

Read the repository instructions, the installed wayfinder workflow, and
`docs/plans/wayfinder-bike-release.md`. Inspect live Git and worktree state.
Select the next unblocked active task, then run the task workflow against its
plan with `wayfinder/bike-release` as the base branch. Retarget the resulting
pull request to `wayfinder/bike-release`, confirm the retarget landed, and stop
after opening the pull request.
