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
| 07 | server-history-trends | [ox-alpha-proxy-07-server-history-trends](ox-alpha-proxy-07-server-history-trends.md) | `task/ox-alpha-proxy-07-server-history-trends` | todo |
| 08 | admin-car-routes | [ox-alpha-proxy-08-admin-car-routes](ox-alpha-proxy-08-admin-car-routes.md) | `task/ox-alpha-proxy-08-admin-car-routes` | todo |
| 09 | boat-capture-retention | [ox-alpha-proxy-09-boat-capture-retention](ox-alpha-proxy-09-boat-capture-retention.md) | `task/ox-alpha-proxy-09-boat-capture-retention` | todo |
| 10 | boat-inspection-surfaces | [ox-alpha-proxy-10-boat-inspection-surfaces](ox-alpha-proxy-10-boat-inspection-surfaces.md) | `task/ox-alpha-proxy-10-boat-inspection-surfaces` | todo |
| 11 | plane-matrix-expansion | [ox-alpha-proxy-11-plane-matrix-expansion](ox-alpha-proxy-11-plane-matrix-expansion.md) | `task/ox-alpha-proxy-11-plane-matrix-expansion` | todo |
| 12 | plane-parity-implementation | [ox-alpha-proxy-12-plane-parity-implementation](ox-alpha-proxy-12-plane-parity-implementation.md) | `task/ox-alpha-proxy-12-plane-parity-implementation` | todo |
| 13 | plane-verification-docs | [ox-alpha-proxy-13-plane-verification-docs](ox-alpha-proxy-13-plane-verification-docs.md) | `task/ox-alpha-proxy-13-plane-verification-docs` | todo |

## Completed

<!-- newest first; one entry appended per task completion -->

- **06 core-history-trends** — PR #7. Core history domain: resolveCalendarRange (inclusive `to`, half-open UTC instants, DST-aware), aggregateDailyBuckets/aggregateRangeFromBuckets through one shared path with ADR 0003 propagation at both levels, exact multi-select modelFilter, history record projection plus offset pagination. 24 new vitest cases. Verify green; CI pass.

- **05 admin-overview** — PR #6. TanStack Query Overview bootstrapping from health/summary, SSE subscription with 10s refetch backstop, pure connection state machine (bootstrapping/live/reconnecting/stale/degraded/unavailable) retaining shell and last summary, cost rendered complete-or-unavailable never $0. 17 vitest cases. BIKE PHASE BOUNDARY: "Live validation outstanding" recorded in the PR body per ADR 0011. Verify green; CI pass.

- **04 server-ingest-api** — PR #4. SQLite usage database (WAL, user_version migration gate, insert+watermark in one immediate transaction, quarantine table), startup backfill + reconciliation with watcher as acceleration only, delete-and-reingest rebuild equivalence proven by test; /api/health, /api/summary, /api/events (monotonic event ids, retry guidance, keepalives, disconnect cleanup). 12 vitest cases. Verify green; CI pass.
- **03 proxy-forwarding** — PR #5. Transparent forwarding of the full HTTP surface with observation taps on POST /v1/responses that extract final Responses usage without ever gating bytes; atomic sanitized sidecar v1 writes through core pricing with crypto.randomUUID recordIds; body-free live status file signal; zero runtime deps. 13 node --test cases including forwarding fidelity vs fixture upstream and failure isolation. Verify green; CI pass.

- **02 core-usage-pricing** — PR #3. Core domain: normalized usage with subset-checked details; streaming/non-streaming Responses adapters selecting the authoritative final usage; pico-dollar pricing engine with rates ported verbatim from the codex-proxy catalogue and typed unavailability reasons (ADR 0003); strict sidecar v1 validator per the spec field table; DST-aware Today aggregation with explicit clock/timezone. Deterministic and dependency-free. recordId generation stays a proxy concern. Verify green; CI pass.

- **01 foundation-workspace** — PR #2. Stood up the pnpm workspace with all four packages, five-gate verify (typecheck, test, build, check, anti:slop), CI running gates as individual steps, bootstrap-worktree script, env examples with `REPORT_TZ=America/New_York`, lockfile committed. Deviations: the claude-proxy anti-slop plugin is not publicly installable, so `.oxlintrc.json` uses stock oxlint warn categories; docs lint is an internal zero-dep link checker. Verify green; CI pass.

## Agent kickoff prompt

Read the repository instructions in AGENTS.md, the wayfinder workflow, and this
map. Inspect live Git and worktree state. Execute the next unblocked active task
by running the task workflow against its plan with the campaign base branch
`wayfinder/ox-alpha-proxy` as the base; retarget the resulting pull request to
that base branch; and stop after opening it.
