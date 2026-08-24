---
type: adr
title: "Deletion policy, split by tier"
description: Records, usage and cost are never deleted; bodies age out under an age and byte cap through the typed blob_evicted tombstone.
tags: [monorepo, storage, retention, privacy, campaign]
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

# Deletion policy, split by tier

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

## Context

The captured corpus is large and almost all of the size is in one place. Bodies — request
and response payloads — account for roughly 27 GB, while the records describing them, their
usage counts and their costs are small. A single retention policy over the whole corpus has
to choose between keeping 27 GB forever and throwing away the analysis history along with
the bulk.

That is a false choice, because the two tiers have opposite value curves. A body's value
decays fast: it matters while a session is live and while its skim is being derived, and
rarely after. A record's value is cumulative: trends, suggestions, and the judge all get
better the longer the history runs, and a deleted record is a permanent hole in every one
of them.

## Decision

**The policy is split by tier, and the split is the decision.**

### Records, usage and cost are never deleted

A record, its usage counts and its cost are **never** deleted — not by an age policy, not
by a size cap, not by a cleanup job. Trends, suggestions and the judge keep their full
history, permanently. There is no retention window on this tier and no operation that
prunes it.

### Bodies age out

**Bodies age out under ox's age and byte cap** — the existing two-limit policy, whichever
binds first — because bodies are the 27 GB and records are the value.

Eviction is **routed through the typed `blob_evicted` tombstone that already exists**,
rather than by deleting rows or nulling columns. That distinction is the operational point:
a tombstone says *this body existed and was evicted on purpose*, which is a different fact
from a body that was never captured, and both a reader and an operator need to tell them
apart. Nulling the column collapses the two into one indistinguishable state.

## Consequences

- Storage growth is bounded by the body cap plus the unbounded but small record tier.
- Any body-reading path must handle `blob_evicted` as a first-class outcome, distinct from
  "absent" and from "not yet captured", and surface it as such rather than as an error.
- Anything derived from bodies must be derived **before** eviction, because after it the
  inputs are gone. `request_skim` is exactly that, and it is why the database is not
  rebuildable from sidecars — see [0047](0047-sqlite-substrate-with-forward-only-migrations.md).
- Full-body inspection of old traffic is not available, by design. The skim is what
  survives, and it is derived with that in mind.
- A permanent record tier is a privacy commitment as much as a storage one: the records are
  small, they are local, and [0049](0049-capture-every-body-redact-on-read.md) governs what
  leaves the machine.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
