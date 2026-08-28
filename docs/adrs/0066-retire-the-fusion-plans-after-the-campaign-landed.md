---
type: adr
title: Retire the fusion plans after the campaign has already landed
description: Ticket zz runs on main rather than on the campaign base, because the campaign merged and its integration branch the-great-merge no longer exists on origin.
tags: [monorepo, campaign, docs, wayfinder]
timestamp: 2026-08-27
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 0
needs-human: true
---

# Retire the fusion plans after the campaign has already landed

## Status

Proposed by `/dev` while running the `monorepo-fusion` campaign's final ticket. **A human
has not ratified this decision.** Flagged because it runs a campaign ticket outside the
campaign — on `main`, with no campaign pull request to carry it.

## Context

`/dev`'s Step 5 contract says a ticket lands on `wayfinder/<slug>`, and that a ticket which
cannot be given `--into wayfinder/<slug>` is a stop. That contract governs a **live**
campaign, where a ticket leaking onto the integration branch would bypass the campaign pull
request and land unreviewed work by the back door.

This campaign is not live. It closed:

- PR #289 merged `wayfinder/monorepo-fusion` into `the-great-merge`, and PR #295 merged
  `the-great-merge` into `main`. The campaign's content is on `main`.
- `origin/wayfinder/monorepo-fusion` is **20 commits behind `main`**. Re-merging it would
  replay work that already landed.
- `the-great-merge` is **gone from origin**, so nothing can target it.

So the branch the contract names cannot receive this ticket, and the plan residue the ticket
removes is not on that branch — it is on `main`.

This record does **not** supersede
[ADR 0059](0059-land-the-fusion-campaign-incomplete.md). 0059's decision to land the
campaign incomplete stands exactly as written. 0059 listed two questions a human still owed,
and one of them was whether `zz` should run against a still-paused ticket 09. The human has
now answered it. This record discharges that open question; it replaces nothing.

## Decision

**Ticket `zz` runs `--base main --into main`, as a single `/god`.**

The base is `main` because that is where the residue sits. The merge target is `main`
because no other branch exists to take it. The ticket is one merge-through run rather than a
wave, because it is one documentation-only change with no unit to collide with.

## Consequences

**This campaign's record now ends with a ticket that never appeared in a campaign pull
request.** A reader reconstructing the campaign from its pull requests alone will find 01
through 25 and then stop, with the plan files already gone and nothing in that sequence
explaining who removed them. That is the reason this record exists: the campaign map's
Completed log and this ADR are the only places the last ticket is written down.

**The precedent is narrow, and its narrowness is the point.** A ticket may run outside its
campaign only once that campaign's integration branch no longer exists on origin. While the
branch is alive the Step 5 contract holds unchanged, because then the bypass it forbids is
real.

## Alternatives considered

**Revive `the-great-merge` to host one documentation-only ticket.** Rejected. It is ceremony
with no reviewer benefit — the same diff, reviewed by the same person, arriving one merge
later — and it is not free: recreating that branch re-opens the rename-crossing merge ADR
0059's residual risk 5 already prices, where 367 of 510 tracked files relocate across the
two hottest trees. Paying a rename-crossing merge to satisfy a rule about a campaign that
has already closed is the wrong trade.

**Leave the residue on `main` permanently.** Rejected. It is the outcome the ticket's own
plan names as the cost of skipping it: a directory of done plans belonging to a campaign
that ended, owned by nobody, that every later reader has to work out is dead. That is not a
hypothetical — `docs/wayfinder/` already carries exactly that residue from two earlier
campaigns, which is the live demonstration.
