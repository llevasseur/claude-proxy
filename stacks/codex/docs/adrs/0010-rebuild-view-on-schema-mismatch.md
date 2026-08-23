---
type: adr
title: Rebuild the view on schema version mismatch
description: A user_version mismatch invalidates the disposable SQLite view; no migration chain exists.
tags: [architecture, sqlite, car]
timestamp: 2026-08-22
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
