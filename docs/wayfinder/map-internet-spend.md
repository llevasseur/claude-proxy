---
type: wayfinder-map
title: Wayfinder — Internet Spend meter
description: A device-level internet usage meter — stacks/net samples macOS network counters hourly and the claude admin dashboard surfaces wire bytes, daily history, agent share and an optional budget.
tags: [wayfinder, dashboard, net, usage]
timestamp: 2026-08-25
scope: net
slug: internet-spend
---

# Wayfinder — Internet Spend

**Slug:** `internet-spend`
**Base branch:** `wayfinder/internet-spend` (cut from `main`; every ticket targets it)
**Plans directory:** `docs/wayfinder/`
**Started:** 2026-08-25
**Goal:** Ship a fourth stack `stacks/net/` whose resident collector samples `nettop` hourly into its own SQLite database, serves real byte totals over port 8531, and gives the claude admin dashboard an `/internet` page plus an optional Overview budget meter — every displayed number measured from this machine, holes where data is missing.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature and spec docs.

Decisions this campaign made are recorded as
`docs/wayfinder/decision-internet-spend-001`–`005`, decided by `/dev`,
unratified; 001 and 005 carry `needs-human: true`.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 01 | net-store-and-read-model | [internet-spend-01-net-store-and-read-model](internet-spend-01-net-store-and-read-model.md) | `task/internet-spend-01-net-store-and-read-model` | todo |
| 02 | net-collector-and-api | [internet-spend-02-net-collector-and-api](internet-spend-02-net-collector-and-api.md) | `task/internet-spend-02-net-collector-and-api` | todo |
| 03 | internet-route-page | [internet-spend-03-internet-route-page](internet-spend-03-internet-route-page.md) | `task/internet-spend-03-internet-route-page` | todo |
| 04 | overview-budget-meter | [internet-spend-04-overview-budget-meter](internet-spend-04-overview-budget-meter.md) | `task/internet-spend-04-overview-budget-meter` | todo |

Dependencies: 02 depends on 01; 03 and 04 depend on 02 (for the API contract)
and are independent of each other.

## Completed

<!-- newest first; one entry appended per task completion -->

## Agent kickoff prompt

Read the repository's AGENTS.md, the wayfinder workflow, and
`docs/wayfinder/map-internet-spend.md`. Inspect live Git and worktree state.
Execute the next unblocked active task by running the task workflow against its
plan with `wayfinder/internet-spend` as the base branch; retarget the resulting
pull request to that base branch; stop after opening it.
