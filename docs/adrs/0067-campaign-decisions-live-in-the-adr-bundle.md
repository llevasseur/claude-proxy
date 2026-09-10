---
type: adr
title: A campaign's decision records live in the ADR bundle, not beside its map
description: docs/wayfinder is deleted wholesale at campaign close, so a decision recorded only there is destroyed at the moment the code depending on it lands; internet-spend's five records move to docs/adrs.
tags: [docs, adrs, campaigns, wayfinder]
timestamp: 2026-08-27
scope: all
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 0
---

# A campaign's decision records live in the ADR bundle, not beside its map

## Status

Proposed by `/dev` during the `internet-spend` campaign, resuming it unattended.
**A human has not ratified this decision.** It is not flagged `needs-human`: it
applies a rule the repository and the workflow already state, to a campaign that
departed from them, and it changes where files live rather than what any of them
claims.

## Context

This decision came from an audit of the campaign's own scaffolding rather than
from a grill round, so there is no griller question to quote.

The `internet-spend` campaign recorded five decisions as
`docs/wayfinder/decision-internet-spend-001` through `005`, two of them carrying
`needs-human: true`. They sit in a directory the repository documents as
disposable. `scripts/check-docs.mjs` says so where it exempts the section from
its `scope` assertion:

> `wayfinder/` holds a campaign's ephemeral scaffolding, which that campaign's
> final ticket deletes wholesale.

The campaign map repeats it — "Ephemeral scaffolding, deleted when the wayfinder
closes" — and the close operation deletes the map. So five unratified decisions,
including the two a human is specifically owed a call on, are stored in the one
directory guaranteed to be swept at exactly the moment the code that depends on
them reaches `main`. The decisions would survive only by the accident that a
`<slug>-*.md` glob does not match a `decision-`-prefixed name.

**The repository already does this correctly elsewhere.** The `provider-seam`
campaign's `/dev` decisions are ordinary ADRs in the durable bundle —
`docs/adrs/0065-cost-is-resolved-at-read-time.md` carries `type: adr`,
`scope: all`, `decided-by: /dev`, `ratified: false`, `wayfinder: provider-seam`
and `needs-human: true`. `internet-spend` is the deviation, not the precedent.

## Decision

**The five `decision-internet-spend-*` records move into `docs/adrs/`** as
ordinary ADRs, numbered in sequence after `0065`, keeping their bodies, their
verbatim griller questions, and every `/dev` frontmatter key including
`ratified: false` and the two `needs-human: true` flags. `type: decision` and
the `map:`/`label:` keys that bound them to the map give way to the ADR bundle's
`type: adr` and `scope`. Inbound references are repointed with them — `AGENTS.md`
links `decision-internet-spend-005` today, and the campaign map cites all five.

Campaigns after this one write decisions straight into `docs/adrs/` and never
into the plans directory.

## Consequences

The decisions outlive the campaign that made them, which is the whole point of
recording them. `okq --bundle docs find --where ratified=false` and
`--where needs-human=true` return them alongside every other unratified `/dev`
decision, so the human's review list is one query rather than one query plus a
directory that is about to be deleted.

The cost is that a campaign's decisions are no longer co-located with its map
while the campaign runs. That is the right trade: the map is scaffolding and the
decisions are not, and the map can cite them by path for as long as it exists.
