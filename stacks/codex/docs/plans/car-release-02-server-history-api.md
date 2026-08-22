---
type: plan
title: Car ticket 02 — Server history API and view schema v2
description: Rebuildable records view, /api/history and /api/trends endpoints, and the SSE data-version signal.
tags: [plan, car, server]
timestamp: 2026-08-22
---

# Car ticket 02 — Server history API and view schema v2

Extend the server's SQLite materialized view and local API with Car's durable history, trend, and filter surfaces. Final sidecars remain the source of truth; SQLite stays disposable.

## Criteria

1. Bump the view to schema version 2 storing the per-record fields the new queries need (including the model identifier and a resolvable day key). On opening a database whose `user_version` is not 2, discard or recreate it empty and let startup backfill re-ingest every final sidecar (ADR 0010) — no in-place migration chain. Deleting the database still reproduces identical query results.
2. Add `GET /api/history`: paginated per-request listing from stored sanitized fields only (`recordId`, `timestamp`, `model`, `endpoint`, `responseStatus`, `requestId`, token figures, nullable cost with typed reason), ordered newest first by timestamp with `recordId` tiebreaker, bounded page size (ADR 0015).
3. Add `GET /api/trends`: daily buckets from core over the requested range, each bucket complete-or-unavailable independently, plus the range aggregate (ADR 0009).
4. Both endpoints accept `from`/`to` inclusive report-timezone calendar dates resolved through core, both optional with the ADR 0011 defaults (earliest ingested day; today; all history), plus repeated exact-match `model` parameters (ADR 0014). Unmatched model values return empty results. Each response carries the monotonic data version.
5. Extend `/api/events` with exactly one new event kind: a data-version advancement signal emitted whenever ingest advances the view, including out-of-today backfill and reconciliation, carrying no history/trend payloads and preserving the Bike contract — initial snapshot, monotonic event IDs, retry guidance, keepalives, disconnect cleanup (ADR 0012).
6. Keep `/api/summary` byte-compatible in shape: Today only, unchanged.
7. Tests cover: rebuild-on-mismatch reproducing seeded results, pagination determinism, DST-spanning range resolution through the HTTP layer, filter narrowing and empty-result semantics, data-version emission on ingest including out-of-today sidecars, SSE continuity across the new event kind, and unchanged `/api/summary`.
8. `pnpm verify` passes.

## Lane

Owns `server/**`. Must not touch `packages/core/**` except importing it, `apps/admin/**`, `proxy/**`, or `docs/**`. Build against the core interface this ticket's predecessor pins; if that interface is missing on the base branch, stop and report rather than reimplementing it here.
