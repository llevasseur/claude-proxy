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
unratified; 001 and 005 carry `needs-human: true`. Ticket 06 moves those five
into `docs/adrs/`, where they survive this campaign's close
([ADR 0067](../adrs/0067-campaign-decisions-live-in-the-adr-bundle.md)).
Two further decisions were made while resuming the campaign and were written
straight into the ADR bundle:
[0066](../adrs/0066-a-campaign-clears-its-own-lint-debt.md) (`needs-human`) and
[0067](../adrs/0067-campaign-decisions-live-in-the-adr-bundle.md).

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 03 | internet-route-page | [internet-spend-03-internet-route-page](internet-spend-03-internet-route-page.md) | `task/internet-spend-03-internet-route-page` | in-progress |
| 04 | overview-budget-meter | [internet-spend-04-overview-budget-meter](internet-spend-04-overview-budget-meter.md) | `task/internet-spend-04-overview-budget-meter` | todo |
| 06 | relocate-decision-records | [internet-spend-06-relocate-decision-records](internet-spend-06-relocate-decision-records.md) | `task/internet-spend-06-relocate-decision-records` | in-progress |

Dependencies: 02 depends on 01; 03 and 04 depend on 02 (for the API contract).
Tickets 03 and 06 are both complete and open — PR #313 and PR #314 — and both
were blocked from merging by the inherited `anti:slop` debt ticket 05 has now
cleared. That is why each reads in-progress with no run behind it: each needs
the campaign base merged in and CI re-run before it can land. Ticket 04 depends
on 03 as well as 02: its budget meter links to `/internet`, and under the typed
router that link does not typecheck until 03's route exists.

## Completed

<!-- newest first; one entry appended per task completion -->

- 05 — net-anti-slop-debt: merged as #315. Clears all 74 `anti:slop` errors
  tickets 01 and 02 landed ungated, at root severity and with no waiver — no
  `biome.json` override, no `stacks/net/.oxlintrc.json`, no rule demoted, no
  suppression comment ([ADR 0066](../adrs/0066-a-campaign-clears-its-own-lint-debt.md)).
  Two root causes rather than 74 separate fixes: `node:sqlite` returns
  `Record<string, SQLOutputValue>` and an `interface` never gets an implicit
  index signature, so `SampleRow`, `ConfigRow`, `VersionRow` and `NetConfig`
  became object types and every `as unknown as` chain collapsed to one
  assertion with one `SAFETY:` line; and a new `src/json.ts` decodes at the I/O
  boundary, retiring all six `typeof` checks rather than exempting them. Review
  caught a real waiver en route — retyping `json()`'s body to `ApiReply['body']`
  satisfied the rule only because it matches a literal `unknown` keyword node
  while the type still resolved to `unknown`; it is now `JsonValue`. 82 tests
  unchanged; CI green. Its plan file was retired with the ticket, so this entry
  carries no link.

- 02 — net-collector-and-api: merged as #312. Ships `stacks/net/packages/server/`
  — a resident hourly `nettop` timer (decision 005, no launchd), ticket 01's
  delta/discontinuity write rules applied per batch inside one transaction, and
  four routes on port 8531 (`/api/summary`, `/api/days`, `GET`/`PUT /api/config`)
  with open CORS on reads and origin-checked writes. Adds the fourth zellij
  layout and the AGENTS.md stack row. 82 vitest cases beside the package.
  **Deviation, needs human:** this macOS build's `nettop -L 1` never emits the
  planned `name.pid`-with-interface row — process totals carry no interface and
  interface-bearing flow rows name no process, with no join key — so flow rows
  are stored under their tuple with synthetic pid 0. Wire-byte totals, deltas
  and discontinuities hold; agent share stays empty under the default patterns
  on this build. Folds into decision 001's review. Its plan file was retired
  with the ticket, so this entry carries no link.

- 01 — net-store-and-read-model: merged as #311; its plan file was retired with
  the ticket, so this entry carries no link.

## Agent kickoff prompt

Read the repository's AGENTS.md, the wayfinder workflow, and
`docs/wayfinder/map-internet-spend.md`. Inspect live Git and worktree state.
Execute the next unblocked active task by running the task workflow against its
plan with `wayfinder/internet-spend` as the base branch; retarget the resulting
pull request to that base branch; stop after opening it.
