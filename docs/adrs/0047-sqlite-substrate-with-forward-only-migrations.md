---
type: adr
title: SQLite is the query substrate, with a forward-only migration ladder
description: claude 0004's indexed substrate wins repo-wide and codex 0010's rebuild-on-mismatch is dropped, because the database holds derived data no sidecar can reproduce.
tags: [monorepo, sqlite, storage, migration, campaign]
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

# SQLite is the query substrate, with a forward-only migration ladder

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

**Adopts [0004](0004-adopt-sqlite-as-the-query-substrate.md) repo-wide, and supersedes
[0028 — Rebuild the view on schema version mismatch](0028-rebuild-view-on-schema-mismatch.md).**

## Context

Both positions were reasonable when they were written. 0004 made SQLite an indexed query
substrate over the captured logs. 0028 — codex's `0010` — decided that a `user_version`
mismatch simply invalidates the database: no migration chain exists, so the operator deletes
it and startup backfills a fresh one from the final sidecars.

0028's argument rests on one premise: **that everything in the database can be rebuilt from
the sidecars.** Where that holds, rebuild-on-mismatch is strictly better than a migration
ladder — no migration code, no migration bugs, and the rebuild is verifiable against the
files it came from.

## Decision

**claude 0004 wins. The database is the query substrate, and it migrates forward through a
versioned ladder. codex 0010's rebuild-on-mismatch is dropped.**

A schema change is a numbered migration applied in order. A database at an older version is
migrated up. A `user_version` mismatch is never resolved by deletion.

### The reason is evidence, not preference

This is the part that must not be softened into "we preferred migrations", because the
decision does not rest on a preference. **0028's premise is false.**

`request_skim` is **derived before body eviction**, and the derivation is **forward-only**:
the skim is computed as a request is captured, while its bodies are still present, and
bodies age out afterwards under the eviction policy in
[0048](0048-deletion-policy-split-by-tier.md).

So for any day whose bodies have already been evicted, **the database holds data that no
sidecar can reproduce.** The inputs the skim was derived from are gone. A rebuild would not
regenerate that skim — it would produce a database missing it, and it would do so silently,
because a rebuild reports success by definition: it reads every sidecar it can find and
writes what they contain. The absence would surface later as history that thins out the
further back you look.

That is the whole argument. Rebuild-on-mismatch is safe exactly while the database is
purely derived, and `request_skim` is the counterexample that makes it unsafe here.

## Consequences

- Every schema change costs a migration, written and tested, and migrations are ordered and
  applied forward. This is real recurring work and is the price of the guarantee.
- The database is **no longer disposable**, and anything calling it a disposable view is
  now wrong. It is a store holding derived data with no other source, so it is backed up
  and migrated like a store.
- Deleting a database still works as a recovery of last resort, and it now has a cost that
  must be stated when it is offered: the skim for evicted days does not come back.
- A future derived column that *is* reproducible from sidecars does not reopen this. The
  ladder is per-database, not per-column, and one irreproducible column is enough to
  require it.
- 0028 stays in the corpus as the superseded record. Its reasoning is the clearest
  statement of when rebuild-on-mismatch *is* correct.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
