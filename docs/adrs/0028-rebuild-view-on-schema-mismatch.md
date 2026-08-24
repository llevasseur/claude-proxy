---
type: adr
title: Rebuild the view on schema version mismatch
description: A user_version mismatch invalidates the disposable SQLite view; no migration chain exists.
tags: [architecture, sqlite, car]
timestamp: 2026-08-22
scope: codex
provenance:
  - repo: codex-proxy
    number: "0010"
    file: docs/adrs/0010-rebuild-view-on-schema-mismatch.md
decided-by: /dev
ratified: false
wayfinder: car-release
grill-round: 2
needs-human: false
---

# Rebuild the view on schema version mismatch

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “When Car changes the SQLite view schema, must existing Bike databases be migrated in place (bumping `user_version` with a new migration that preserves ingested rows), or is the intended contract that a `user_version` mismatch simply invalidates the database so the operator deletes it and lets startup backfill rebuild it from final sidecars?”

No document defines schema evolution for the disposable view.

## Decision

Treat a `user_version` mismatch as invalidation of the view. When the server opens a database whose `user_version` is not the current Car schema version, discard or recreate it empty and let startup backfill re-ingest every final sidecar. Do not build an in-place migration chain.

## Consequences

- Sidecars are immutable and complete for everything the view holds, so a row-preserving migration preserves nothing that cannot be rebuilt deterministically.
- The rebuild-on-mismatch path replaces manual deletion as the recovery story across schema upgrades.
- Every schema change still bumps `PRAGMA user_version` so mismatches stay detectable.

## Provenance

Inherited from `codex-proxy` `docs/adrs/0010-rebuild-view-on-schema-mismatch.md` (`codex#0010`) and
renumbered to 0028 when the three corpora were merged into this bundle during the
`monorepo-fusion` campaign. The decision itself is unchanged; its ratification fields are
carried over verbatim under ADR 0052, and references to sibling records were repointed at
their new numbers. The original persists in this repository's own git history, which is the
form ADR 0029 blessed.
