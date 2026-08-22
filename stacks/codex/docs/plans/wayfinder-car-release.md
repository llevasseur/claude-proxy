---
type: wayfinder
title: Wayfinder — Car release
description: Campaign map for the Car phase — durable usage history, trend views, date ranges, and model filters.
tags: [wayfinder, car]
timestamp: 2026-08-22
---

# Wayfinder — Car release

**Slug:** `car-release`
**Base branch:** `wayfinder/car-release` (cut from the default branch; every ticket targets it)
**Plans directory:** `docs/plans`
**Started:** 2026-08-22
**Goal:** Ship Car — durable usage history, trend views, date ranges, and model/range filters that preserve every Bike outcome.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature and spec docs.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 02 | server-history-api | [car-release-02-server-history-api](car-release-02-server-history-api.md) | `task/car-release-02-server-history-api` | todo |
| 03 | admin-history-trends | [car-release-03-admin-history-trends](car-release-03-admin-history-trends.md) | `task/car-release-03-admin-history-trends` | todo |
| 04 | car-docs-verification | [car-release-04-car-docs-verification](car-release-04-car-docs-verification.md) | `task/car-release-04-car-docs-verification` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

- **01 core-range-trends** — PR #14. Added `packages/core/src/history.ts`: `resolveCalendarRange` (optional inclusive `from`/`to` → half-open UTC instants against an explicit timezone, DST-aware), `aggregateDailyBuckets` (complete per-day aggregates with independent ADR 0003 cost semantics and window boundaries), `aggregateRangeFromBuckets` (bucket sums equal range totals through one shared path), and `modelFilter`/`selectByModels` (exact multi-select, empty selection matches all). Exported day-boundary helpers from `today.ts`. 21 new core tests including DST spring/autumn days, single-day windows, unpriced propagation at both levels, and a seeded 50-fixture property test. No deviations from the plan.

## Agent kickoff prompt

Read the repository instructions in AGENTS.md, the wayfinder workflow, and this
map. Inspect live Git and worktree state. Execute the next unblocked active task
by running the task workflow against its plan with the campaign base branch
`wayfinder/car-release` as the base; retarget the resulting pull request to that
base branch; and stop after opening it.
