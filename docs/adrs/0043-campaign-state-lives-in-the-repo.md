---
type: adr
title: Campaign state lives in the repo, and the wayfinder map is the control plane
description: No issue tracker and no project board; a campaign's tickets, statuses and history are markdown in the repository.
tags: [monorepo, process, campaign, wayfinder]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# Campaign state lives in the repo, and the wayfinder map is the control plane

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

## Context

A campaign of this size is dozens of tickets across weeks, executed by agents that do not
share a session. Every one of them resumes cold. The question is where the state they
resume from lives.

GitHub Issues and a project board are the obvious answer and the wrong one here. They are a
second source of truth that has to be kept in step with the branches by hand, they are not
in the diff, they are not available to an agent that only has a checkout, and their history
is not the repository's history.

## Decision

**A campaign's entire state is markdown in the repository, and the wayfinder map is its
control plane.** `docs/wayfinder/wayfinder-<slug>.md` holds the active-tasks table — one
row per ticket carrying its number, plan link, branch, status and note — and the Completed
log. Each ticket is one plan file beside the map and one branch cut from the campaign base.

**No issues, no labels, no project board items.** That layer is replaced, not
supplemented — running both is the failure this decision avoids, since two trackers
disagree the moment one of them is updated and the other is not.

**The map's status column is the resuming agent's whole briefing**, so it carries a closed
vocabulary rather than free text: `todo`, `in-progress`, `paused`, `blocked-limit`,
`rejected`, `redo`. Three of those are stopped states and are deliberately not
interchangeable — never started, stopped by a human's refusal, and stopped by a usage
window are three different instructions to the next agent.

**Campaign scaffolding is ephemeral on a schedule rather than by accident.** Plans stay for
the campaign's life, marked done in place so any ticket can be restarted from what was
asked; the campaign's final `zz` ticket deletes them all; the map goes when the campaign
closes. The durable record is the merged code and this bundle.

## Consequences

- A campaign is reviewable in a diff, and its history is the repository's history.
- An agent with nothing but a checkout can resume the campaign. No API token, no board
  access, no network.
- The map is a file in the repository, so whoever can edit it can steer the campaign —
  including handing a later resume the unattended flag. That escalation is accepted, and
  it is recorded in the command toolkit's own decision corpus rather than here — the
  wayfinder command documents it as `0006-unattended-campaigns-resume-unattended`.
- A stale `in-progress` row is the one failure mode that can freeze a campaign, because a
  run whose usage window ran out rarely gets the turn in which it would have written
  `blocked-limit`. Repairing those rows is a resuming agent's job and comes before picking
  a ticket.
- Campaign state and decision records are different objects with different lifetimes: the
  map is scaffolding and is deleted, the ADRs it produced are durable and are not.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
