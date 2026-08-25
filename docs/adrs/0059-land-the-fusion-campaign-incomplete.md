---
type: adr
title: Land the fusion campaign incomplete, with the corpus migration still paused
description: The campaign merges into the-great-merge with 24 of 25 numbered tickets done; ticket 09 stays paused and ticket zz stays undone, because the work that blocks them is a human's to authorise and nothing downstream waits on either.
tags: [monorepo, campaign, migration, storage]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 0
needs-human: true
---

# Land the fusion campaign incomplete, with the corpus migration still paused

## Status

Proposed by `/dev` while landing the `monorepo-fusion` campaign. **A human has not
ratified this decision.** Flagged because it closes a campaign against its own map: the
map's `zz` ticket says it is executed last and that nothing else removes the plan files,
and this decision leaves both it and ticket 09 outstanding.

## Context

No griller round produced this question. It was decided at the head of a `/dev` run whose
own campaign — `provider-seam` — cannot be charted at all until the fused `stacks/`
layout is on `the-great-merge`, and it was directed by the human who started that run.

The measured state at the time of the decision:

- `origin/the-great-merge` carries the **pre-fusion** layout. Its tree has no `stacks/`
  directory, its `pnpm-workspace.yaml` lists `proxy`, `server`, `packages/*`, `apps/*`
  and `services/*`, and one single filename in the whole tree matches `ox-alpha` or
  `codex`.
- `origin/wayfinder/monorepo-fusion` is **200 commits ahead** of it and unmerged. That
  branch is where the three fused stacks actually live.
- The only pull request ever targeting `the-great-merge` is **#263**, already merged, and
  that was the planning pull request. **No campaign pull request exists.**
- The campaign map records **24 of the 25 numbered tickets complete** — 01 through 25
  except 09 — with ticket 09 `paused` and ticket `zz` `todo`.

So the fused layout exists only on a branch nothing has merged, and every later campaign
that builds on `stacks/` is blocked behind a merge that was never performed.

## Decision

**Close the campaign and merge it into `the-great-merge` now, with ticket 09 paused and
ticket `zz` undone.**

**Ticket 09 `migrate-corpora` stays paused, and is not to be resumed or unblocked as part
of this landing.** It stopped before its `mv` deliberately, not by failure. All three
corpora have live proxy and server writers holding open WAL-mode SQLite connections, so
the move risks the corpus, and the ticket's own third criterion — that the byte count
before equals the byte count after — is unassertable while the writers run. Resuming it
needs three things only a human can supply: ratification of
[ADR 0054](0054-each-stack-keeps-its-own-corpus-root.md), authorisation to quiesce the
three stacks, and a choice of byte measure, because `du -sb` is GNU-only and this device
carries BSD `du`.

**Ticket 09 does not block this landing.** It relocates docs corpora. The `stacks/`
layout that the next campaign needs landed in tickets **02, 05 and 06**, all complete.
The two are independent by file scope.

**Ticket `zz` `retire-done-plans` stays undone**, so the campaign's plan files and its map
survive the merge rather than being deleted by it.

## Consequences

**The campaign's own scaffolding outlives its merge.** `docs/wayfinder/` keeps the map and
every `monorepo-fusion-*.md` plan. That is the opposite of the map's stated schedule, and
it is deliberate: ticket 09 is resumable only from its plan, so deleting the plans is what
would make the pause permanent. The plans are retired when 09 is, not before.

**The route-budget gate keeps contributing no evidence.** Residual risk 21 on the map
records that the gate resolves `stacks/claude/logs`, which exists in no checkout, while
the store is still at the repository root. That does not change here. **A green `verify`
on this merge does not include a route-budget measurement**, and reading it as one is the
mistake the map already warns against twice.

**`the-great-merge` takes a rename-crossing merge.** Residual risk 5 records that 367 of
510 tracked files relocate. Every later `main` to `the-great-merge` integration crosses
those renames over the two hottest trees.

**A human still owes two decisions**, and neither is discharged by this record: whether the
corpus migration proceeds on the terms ADR 0054 sets, and whether a campaign that keeps its
scaffolding past its own close is acceptable, or whether `zz` should run against a
still-paused 09.

## Alternatives considered

**Resume ticket 09 first and land the campaign complete.** Rejected. Resuming it means
performing the `mv` against live WAL-mode writers with no authorised quiesce and no
agreed byte measure — precisely the three conditions the ticket paused on. An unattended
run has no human at the point where that goes wrong, and the corpus is not recoverable
from git, because it is untracked.

**Leave the campaign unmerged until a human ratifies ADR 0054.** Rejected as the more
expensive wait. It blocks every downstream campaign on a decision about a data migration
that none of them touch, and it leaves 200 commits of verified, merged-per-ticket work
sitting on a branch where each passing day of `main` widens the rename-crossing merge that
residual risk 5 already prices.

**Run `zz` and retire the plans anyway.** Rejected. It deletes the only artifact from
which ticket 09 can be restarted, converting a deliberate pause into a permanent loss of
the plan.
