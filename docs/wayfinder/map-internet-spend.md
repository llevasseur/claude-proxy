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

Every decision this campaign made lives in the ADR bundle, where it survives the
campaign's close — ticket 06 moved the first five there
([ADR 0067](../adrs/0067-campaign-decisions-live-in-the-adr-bundle.md)). All
seven are `decided-by: /dev` and `ratified: false`; three carry
`needs-human: true` and are the human's review list:

- [0068](../adrs/0068-wire-bytes-and-per-interface-schema.md) — wire bytes, per-interface schema (**needs-human**)
- [0069](../adrs/0069-delta-gap-and-day-semantics.md) — delta rule, gap and day semantics
- [0070](../adrs/0070-period-boundaries.md) — period boundaries
- [0071](../adrs/0071-agent-pattern-matching.md) — agent pattern matching
- [0072](../adrs/0072-collector-residency.md) — collector residency (**needs-human**)
- [0066](../adrs/0066-a-campaign-clears-its-own-lint-debt.md) — the campaign clears its own lint debt (**needs-human**)
- [0067](../adrs/0067-campaign-decisions-live-in-the-adr-bundle.md) — decisions live in the ADR bundle

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|
| 04 | overview-budget-meter | [internet-spend-04-overview-budget-meter](internet-spend-04-overview-budget-meter.md) | `task/internet-spend-04-overview-budget-meter` | in-progress |

Dependencies: 02 depends on 01; 03 and 04 depend on 02 (for the API contract).
Ticket 04 depends on 03 as well: its budget meter links to `/internet`, and
under the typed router that link does not typecheck until 03's route exists —
which it now does, so 04 is unblocked.

## Completed

<!-- newest first; one entry appended per task completion -->

- 06 — relocate-decision-records: merged as #314. Moves the campaign's five
  decision records out of this directory — which is swept at close — into the
  ADR bundle as `docs/adrs/0068`–`0072`, via `git mv` so history follows. Bodies
  are byte-identical, each record's verbatim griller question included; only
  frontmatter and the title heading changed shape. Both `needs-human` flags
  survived on 0068 and 0072, and `AGENTS.md` plus two changelog links were
  repointed. One judgement beyond the plan, accepted: `status: proposed` was
  dropped too, since no ADR in the bundle carries a `status:` key, `ratified:
  false` already encodes it, and each record's own Status section states it.
  Its plan file was retired with the ticket, so this entry carries no link.

- 03 — internet-route-page: merged as #313. The admin `/internet` page —
  self-declared route, `net-api.ts` as its own fetch module (the shared
  `src/api.ts` untouched), headline period total, daily stacked upload/download
  bars with hole days drawn as nothing rather than fabricated zeroes, hatched
  `ReferenceArea` bands over gap/decrease/boot spans, approximate agent share,
  collector status line, on-page budget editor, and an explicit "net-server
  unreachable" state. Two deviations from the plan, both recorded in the PR:
  criterion 3 could not be met from `/api/summary` alone — that route's totals
  are corpus-wide with no period-scoped figure, so the headline sums day buckets
  inside `summary.period` from a second `/api/days` call and reads `—` rather
  than `0` when the period has no samples; and criterion 1's "exactly one line
  in `registry.ts`" is three, because a page carrying a rail station needs its
  station line too. **No visual proof was captured** — it belongs to campaign
  close. Its plan file was retired with the ticket, so this entry carries no
  link.

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
