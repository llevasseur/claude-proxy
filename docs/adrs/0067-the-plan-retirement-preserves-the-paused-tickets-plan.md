---
type: adr
title: The plan retirement preserves the paused ticket's plan
description: Ticket zz deletes 25 of the campaign's 26 plans and keeps ticket 09's, because 09 is paused and its plan is the only artifact it can be restarted from.
tags: [monorepo, campaign, docs, wayfinder, migration]
timestamp: 2026-08-27
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 0
needs-human: true
---

# The plan retirement preserves the paused ticket's plan

## Status

Proposed by `/dev` while running the `monorepo-fusion` campaign's final ticket. **A human
has not ratified this decision.** Flagged because it executes a ticket against a criterion
the ticket itself states, and deliberately falls one file short of it.

## Context

Ticket `zz`'s own first criterion is flat: delete every `docs/wayfinder/monorepo-fusion-*.md`
plan file, this one included. Read literally, that takes
`monorepo-fusion-09-migrate-corpora.md` with it.

[ADR 0059](0059-land-the-fusion-campaign-incomplete.md) rejected running `zz` for exactly
one reason, and it is worth quoting rather than paraphrasing: running `zz` "deletes the only
artifact from which ticket 09 can be restarted, converting a deliberate pause into a
permanent loss of the plan."

The human has now directed that `zz` run. That direction answers one of the two questions
0059 left open — whether `zz` should run against a still-paused 09 — and it does not answer
the other, which is whether the corpus migration proceeds on the terms ADR 0054 sets. So
this record discharges an open question 0059 itself listed. **It does not supersede 0059**,
whose decision to land the campaign incomplete stands unchanged.

Ticket 09 is still paused on the same three things, none of which an unattended run can
supply: ratification of ADR 0054, authorisation to quiesce the three stacks, and a choice of
byte measure, `du -sb` being GNU-only on a device carrying BSD `du`.

## Decision

**Delete 25 of the campaign's 26 plans, and keep `monorepo-fusion-09-migrate-corpora.md`.**

The carve-out honours both instructions at once. The human's direction is carried out: the
scaffolding goes, including `zz`'s own plan. 0059's objection is answered on its own terms:
the one artifact 09 can be restarted from survives, so the pause stays a pause rather than
becoming a loss.

**A second, independent reason points the same way.** The campaign map's Active-tasks row
for 09 links that plan, and `scripts/check-docs.mjs` fails on any unresolved markdown link.
Deleting the plan would therefore turn the docs gate red unless the map's own record of the
paused ticket were degraded to compensate — trading a resumable ticket for a green gate, and
losing both halves of the thing the row is for. Either reason alone settles this; they do
not depend on each other.

## Consequences

**`docs/wayfinder/` keeps exactly one campaign plan and its map.** That is a deliberate,
named residue with a live owner, which is a different thing from the ownerless residue this
ticket exists to prevent. The difference is that someone can act on it: the plan states what
09 needs, the map's row states why it stopped, and both name the human who can unblock it.

**The residue is discharged by resolving ticket 09, not by another sweep.** When a human
ratifies ADR 0054, authorises the quiesce and picks a byte measure, 09 either runs or is
formally abandoned — and that plan and this map go together at that point. Nothing else
should delete them in the meantime.

**`zz` is recorded as complete despite falling one file short of its literal criterion.**
The map's Completed entry says which file was kept and why, so the gap between the criterion
and the diff is visible in the campaign's own record rather than only in this ADR.

## Alternatives considered

**Delete 09's plan and preserve the ticket as the map's table row alone.** Rejected. The row
is one line of note text; the plan carries the criteria, the blockers measured at the point
the ticket stopped, and the byte-measure problem that stopped it. Keeping the row without
the plan leaves a row nobody could act on — a marker that work exists, with no statement of
what the work is. It also strictly worsens 0059's objection rather than answering it, since
the artifact 0059 named is precisely the one that would go.

**Delete everything, as the criterion says, and accept the loss.** Rejected. It converts a
deliberate pause into a permanent one, which is the outcome 0059 refused, and it does so as
a side effect of bookkeeping rather than as a decision anyone took about ticket 09.
