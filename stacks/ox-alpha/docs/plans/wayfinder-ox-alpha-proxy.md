---
type: wayfinder
title: Wayfinder — ox-alpha-proxy build-out
description: Campaign map for the full four-rung build — Bike, Car, Boat, Plane — from empty workspace to pinned parity.
tags: [wayfinder, bike, car, boat, plane]
timestamp: 2026-08-22
---

# Wayfinder — ox-alpha-proxy build-out

**Slug:** `ox-alpha-proxy`
**Base branch:** `wayfinder/ox-alpha-proxy` (cut from the default branch; every ticket targets it)
**Plans directory:** `docs/plans`
**Started:** 2026-08-22
**Goal:** Build ox-alpha-proxy to completion through the four-rung ladder — Bike, Car, Boat, Plane — each rung independently useful and verified before the next opens.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature and spec docs.

## Phase gates (hard blocking edges)

Per [ADR 0009](../adrs/0009-one-campaign-review-granularity.md): tickets 01–05 are Bike; 06–08 Car; 09–10 Boat;
11–13 Plane. No ticket of a later phase may start until every ticket of the earlier phase has merged into this base
branch and `pnpm verify` passes there. Each boundary merge records a "live validation outstanding" note per
[ADR 0011](../adrs/0011-automated-boundary-evidence.md).

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 01 | foundation-workspace | [ox-alpha-proxy-01-foundation-workspace](ox-alpha-proxy-01-foundation-workspace.md) | `task/ox-alpha-proxy-01-foundation-workspace` | todo |
| 02 | core-usage-pricing | [ox-alpha-proxy-02-core-usage-pricing](ox-alpha-proxy-02-core-usage-pricing.md) | `task/ox-alpha-proxy-02-core-usage-pricing` | todo |
| 03 | proxy-forwarding | [ox-alpha-proxy-03-proxy-forwarding](ox-alpha-proxy-03-proxy-forwarding.md) | `task/ox-alpha-proxy-03-proxy-forwarding` | todo |
| 04 | server-ingest-api | [ox-alpha-proxy-04-server-ingest-api](ox-alpha-proxy-04-server-ingest-api.md) | `task/ox-alpha-proxy-04-server-ingest-api` | todo |
| 05 | admin-overview | [ox-alpha-proxy-05-admin-overview](ox-alpha-proxy-05-admin-overview.md) | `task/ox-alpha-proxy-05-admin-overview` | todo |
| 06 | core-history-trends | [ox-alpha-proxy-06-core-history-trends](ox-alpha-proxy-06-core-history-trends.md) | `task/ox-alpha-proxy-06-core-history-trends` | todo |
| 07 | server-history-trends | [ox-alpha-proxy-07-server-history-trends](ox-alpha-proxy-07-server-history-trends.md) | `task/ox-alpha-proxy-07-server-history-trends` | todo |
| 08 | admin-car-routes | [ox-alpha-proxy-08-admin-car-routes](ox-alpha-proxy-08-admin-car-routes.md) | `task/ox-alpha-proxy-08-admin-car-routes` | todo |
| 09 | boat-capture-retention | [ox-alpha-proxy-09-boat-capture-retention](ox-alpha-proxy-09-boat-capture-retention.md) | `task/ox-alpha-proxy-09-boat-capture-retention` | todo |
| 10 | boat-inspection-surfaces | [ox-alpha-proxy-10-boat-inspection-surfaces](ox-alpha-proxy-10-boat-inspection-surfaces.md) | `task/ox-alpha-proxy-10-boat-inspection-surfaces` | todo |
| 11 | plane-matrix-expansion | [ox-alpha-proxy-11-plane-matrix-expansion](ox-alpha-proxy-11-plane-matrix-expansion.md) | `task/ox-alpha-proxy-11-plane-matrix-expansion` | todo |
| 12 | plane-parity-implementation | [ox-alpha-proxy-12-plane-parity-implementation](ox-alpha-proxy-12-plane-parity-implementation.md) | `task/ox-alpha-proxy-12-plane-parity-implementation` | todo |
| 13 | plane-verification-docs | [ox-alpha-proxy-13-plane-verification-docs](ox-alpha-proxy-13-plane-verification-docs.md) | `task/ox-alpha-proxy-13-plane-verification-docs` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

## Agent kickoff prompt

Read the repository instructions in AGENTS.md, the wayfinder workflow, and this
map. Inspect live Git and worktree state. Execute the next unblocked active task
by running the task workflow against its plan with the campaign base branch
`wayfinder/ox-alpha-proxy` as the base; retarget the resulting pull request to
that base branch; and stop after opening it.
