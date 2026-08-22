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
| 04 | car-docs-verification | [car-release-04-car-docs-verification](car-release-04-car-docs-verification.md) | `task/car-release-04-car-docs-verification` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

- **03 admin-history-trends** — PR #16. Added `apps/admin/src/car/`: `/history` route (paginated sanitized listing, cost rendered as amount or explicit unavailable-with-reason, never `$0`), `/trends` route (daily total-usage series with per-day ADR 0003 semantics and a range footer), URL-encoded inclusive calendar dates plus repeated-`model` multi-select filters via a custom search serializer, and SSE data-version refetching that keeps the 30s backstop and last-known-state behavior. Overview untouched except two new nav stations. Client types defined from the documented contract only. One deviation: added `apps/admin/src/styles/components/car.css` for the new views.
- **02 server-history-api** — PR #15. View schema v2 (`002-car-view.sql`, replaces `001`) with per-record columns and a UTC-resolvable `day_key`; any other `user_version` is discarded, recreated, and backfilled from final sidecars. `GET /api/history` (paginated, newest-first with `recordId` tiebreaker, limit cap 200), `GET /api/trends` (core buckets plus range total), optional inclusive report-timezone `from`/`to`, repeated exact-match `model` params, unmatched values returning empty results, malformed queries rejected with 400. One new SSE event kind `data-version` on ingest including out-of-today records; Bike events contract and `/api/summary` untouched. Deviation: replaced `001-initial.sql` rather than adding alongside it, per ADR 0010's no-migration-chain decision.
- **01 core-range-trends** — PR #14. Added `packages/core/src/history.ts`: `resolveCalendarRange` (optional inclusive `from`/`to` → half-open UTC instants against an explicit timezone, DST-aware), `aggregateDailyBuckets` (complete per-day aggregates with independent ADR 0003 cost semantics and window boundaries), `aggregateRangeFromBuckets` (bucket sums equal range totals through one shared path), and `modelFilter`/`selectByModels` (exact multi-select, empty selection matches all). Exported day-boundary helpers from `today.ts`. 21 new core tests including DST spring/autumn days, single-day windows, unpriced propagation at both levels, and a seeded 50-fixture property test. No deviations from the plan.

## Agent kickoff prompt

Read the repository instructions in AGENTS.md, the wayfinder workflow, and this
map. Inspect live Git and worktree state. Execute the next unblocked active task
by running the task workflow against its plan with the campaign base branch
`wayfinder/car-release` as the base; retarget the resulting pull request to that
base branch; and stop after opening it.
