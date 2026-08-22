---
type: plan
title: Car ticket 04 — Durable docs and integration verification
description: Feature, spec, roadmap, and index updates plus full verification of the assembled campaign branch.
tags: [plan, car, docs]
timestamp: 2026-08-22
---

# Car ticket 04 — Durable docs and integration verification

Write Car's durable documentation from what was actually built and run the campaign's integration verification on the assembled base branch.

## Criteria

1. Add `docs/features/car.md` mirroring `docs/features/bike.md`'s shape: product promise (durable history, trend views, date ranges, model filters; every Bike boundary preserved), run shape, data lifecycle, publication boundary; link owning ADRs.
2. Add `docs/specs/car-architecture.md` documenting the built flow: schema v2 view with rebuild-on-mismatch (ADR 0010), `/api/history` and `/api/trends` contracts with parameter semantics (ADR 0011), the SSE data-version signal beside the unchanged Bike events contract (ADR 0012), dashboard routes (ADR 0013), filter semantics (ADR 0014), and the history listing (ADR 0015).
3. Update `docs/features/index.md`, `docs/specs/index.md`, and `docs/index.md` where they enumerate entries. Leave `docs/roadmap/bike-to-plane.md`'s Car section accurate but do not declare Car shipped there — that happens at campaign close.
4. Do not rewrite the seven decision records already in `docs/adrs/`; they stand as written.
5. Integration verification, run against the campaign base branch checkout after merging it up to date:
   - Fresh install: `pnpm install --frozen-lockfile` then `pnpm verify`.
   - Historical accuracy: seeded sidecar fixtures spanning multiple days produce bucket sums equal to range totals through the running server's `/api/trends`.
   - Filters: multi-select model parameters narrow both `/api/history` and `/api/trends`; unmatched values return empty results.
   - Timezone boundaries: ranges spanning a DST transition resolve to correct half-open UTC instants under `REPORT_TZ`.
   - SSE continuity: an open `/api/events` subscriber receives the data-version signal without dropping the stream when a new sidecar lands.
   - Bike regression: transparent forwarding test suite, Today summary, and Overview behavior unchanged.
   Record the evidence for each check in the pull-request body.
6. `pnpm verify` passes.

## Lane

Owns `docs/**` except `docs/plans/**`. Must not touch `packages/core/**`, `server/src/**`, `apps/admin/src/**`, or `proxy/**`. Documentation describes code as merged on the base branch; if reality diverges from an ADR, report the divergence rather than editing the record.
