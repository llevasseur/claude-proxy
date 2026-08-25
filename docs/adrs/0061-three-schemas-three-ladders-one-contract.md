---
type: adr
title: Three schemas, three ladders, one adapter contract
description: The three stores keep their own schemas and their own independent migration ladders; the ProviderAdapter depends on a record contract rather than a shared schema, and each store materialises its provider columns at ingest.
tags: [storage, migration, providers, adapters]
timestamp: 2026-08-25
scope: all
decided-by: /dev
ratified: false
wayfinder: provider-seam
grill-round: 2
needs-human: true
---

# Three schemas, three ladders, one adapter contract

## Status

Proposed by `/dev` during the `provider-seam` campaign. **A human has not ratified this
decision.** Flagged because it fixes the boundary the whole campaign is named for — what
the ProviderAdapter may depend on — and because it settles that the three stores never
converge, which forecloses a design someone may later want.

## Context

The campaign brief asserted a flat invariant: `provider`, `harness`, `model`,
`adapter_version` and `pricing_source` are "columns on every record, never derived
context", and priced the work as "migration 23 on claude's `open.ts`; codex's and ox's
per-proxy stores are CREATED at current version."

Measured against the three stores, both halves break.

- `stacks/claude/server/src/db/open.ts:38` — `SCHEMA_VERSION = 22`, 27 tables, a real
  forward ladder.
- `stacks/codex/server/src/database.ts:22` — `SCHEMA_VERSION = 3`.
- `stacks/ox-alpha/server/src/database.ts:20` — `SCHEMA_VERSION = 1`, and its entire
  schema is **three tables**: `usage_records(record_id, filename, event_timestamp,
  sidecar_json)`, `ingest_watermarks`, `rejected_sidecars`. There is no `model` column, no
  token columns, and no request table. The whole payload is a `sidecar_json` blob.

The griller asked:

> "Ox's store has no per-record columns at all to add them to — a `model` column on
> `usage_records` would be a *new denormalisation of `sidecar_json`*, i.e. exactly the
> derived context the invariant forbids, and every ox query today reads that blob. And
> 'created at current version' names no version: ox is at 1 and codex at 3, on schemas
> that share not one table with claude's 27. So which is it — (a) codex's and ox's stores
> are converged onto claude's schema, which is not an adapter extraction but a rewrite of
> two servers' entire storage and read paths ... or (b) the three stores keep their own
> schemas and their own independent ladders, in which case 'columns on every record' is
> true only of claude, the ProviderAdapter cannot depend on it, and the cross-provider
> fan-out must reconstitute `provider`/`model` by parsing `sidecar_json` at read time?"

## Decision

**(b), with the invariant restated at the adapter boundary rather than at the storage
layer.**

**Three stores, three schemas, three independent ladders.** claude goes 22 → 23, codex
3 → 4, ox 1 → 2. What is shared is the ladder **mechanism** — one implementation, run per
store — never the schema. [ADR 0047](0047-sqlite-substrate-with-forward-only-migrations.md)
supports this directly: "The ladder is per-database, not per-column."

Convergence is refused because it would rewrite two servers' storage and read paths, which
is not an adapter extraction, and because
[ADR 0046](0046-narrowly-scoped-local-writes.md) already ratifies three independent stores
with three writers — converging them would need to supersede a ratified decision to buy
something this campaign does not need.

**The ProviderAdapter depends on a record contract, never on a shared schema.** Its input
is a normalised record; where each store physically keeps the fields is that store's own
business. That is precisely what makes this an extraction rather than a convergence.

**All three stores do get real columns, each by its own additive migration.** Including ox,
where `provider`, `harness`, `model`, `adapter_version` are materialised onto
`usage_records` **at ingest**, from the sidecar ox already parses — it must already parse
it, since it rejects malformed sidecars into `rejected_sidecars`. `sidecar_json` remains
the source of truth; the columns are a materialised projection of it, written once.

**This is not the derived context the invariant forbids.** The invariant's target is
inference **at read time** — never concluding the provider from the harness, or the model
from the provider, which
[ADR 0040](0040-three-providers-and-three-harnesses.md) forbids outright. It is not a
prohibition on persisting a value parsed from the payload at ingest. claude already
establishes that distinction and it is load-bearing there: `skim_text` and `body_derived`
are derivatives computed once from a body at ingest and stored as columns, and the comment
at `open.ts:518` records why the two states must stay apart rather than one being inferred
from the other.

The outcome the contract requires: **no read path reconstitutes provider or model by
parsing the blob.**

**`cost` and `pricing_source` are excluded from this and are not stored at all.** They are
functions of a mutable rate table — see
[ADR 0065](0065-cost-is-resolved-at-read-time.md).

## Consequences

**Two repairs become hard prerequisites, and both are ordering constraints rather than
preferences.** Each is code shipping today that contradicts a ratified ADR, so both cite
0047 and [0048](0048-deletion-policy-split-by-tier.md) rather than needing a decision of
their own.

1. **codex's delete-on-mismatch is removed before codex's ladder is bumped.**
   `stacks/codex/server/src/database.ts:140-143` closes the handle and `rmSync`s the
   database plus its `-wal` and `-shm` files with `{ force: true }`, then re-execs the
   migration. Bumping codex 3 → 4 with that code shipping **destroys codex's corpus** on
   first open. Reversed, this ordering is a data-loss bug rather than a tidy-up. It is
   independently a live violation of 0047 — a `user_version` mismatch is never resolved by
   deletion — and of 0048, which forbids deleting the record tier by any operation.
2. **ox gains a real forward ladder before 1 → 2.**
   `stacks/ox-alpha/server/src/database.ts:105-107` runs its migration only when
   `user_version === 0` and otherwise throws `unsupported database schema version`. That is
   data-safe — ox does **not** delete, unlike codex — but it means ox has no ladder at all,
   so any bump above 1 is an immediate hard failure.

- Each store's version number means something only within its own store. There is no
  global schema version, and comparing 22 against 1 is meaningless.
- A new provider adds a store and a ladder; it does not extend an existing schema.
- The adapter contract is now the compatibility surface, so changing it is a versioned
  change across three stacks — which is what `adapter_version` on every record is for.

## Alternatives considered

**(a) Converge codex and ox onto claude's 27-table schema.** Rejected. It is a rewrite of
two servers' storage and read paths rather than an adapter extraction; it must supersede
ADR 0046 to exist; and it turns ox's blob corpus and codex's data into a real data
migration, which this campaign forbids outright.

**(b) as the griller framed it — keep the schemas and reconstitute provider and model by
parsing `sidecar_json` at read time.** Rejected. It puts a JSON parse on every row of every
aggregate, and it makes provider a read-time derivation, which is the thing ADR 0040
forbids. Materialising at ingest reaches the same place without either cost.
