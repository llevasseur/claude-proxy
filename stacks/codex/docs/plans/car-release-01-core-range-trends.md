---
type: plan
title: Car ticket 01 — Core range and trend domain
description: Pure daily-bucket aggregation over report-timezone calendar ranges with exact model filtering.
tags: [plan, car, core]
timestamp: 2026-08-22
---

# Car ticket 01 — Core range and trend domain

Add pure range, bucket, and filter domain functions to `@codex-proxy/core`. No Node imports, no environment, clock, filesystem, database, or network access; every external input arrives as an explicit parameter.

## Criteria

1. Resolve inclusive calendar dates (`from`, `to`, both optional) against an explicitly provided IANA timezone into half-open UTC instants, reusing the existing timezone-aware day-boundary machinery (`packages/core/src/today.ts`). Omitted `from` is expressed by the caller as "no lower bound"; omitted `to` resolves to the caller-provided current instant's report-day end. A range spanning a DST transition produces correct half-open boundaries.
2. Aggregate sidecar-shaped records into complete daily buckets: each bucket carries the same aggregate shape Today exposes (request count, input/cached-input/output/reasoning-output/total tokens, latest timestamp) plus its resolved half-open UTC window boundaries, and independently carries nullable cost with a typed reason per ADR 0003 applied at the bucket boundary.
3. Aggregate a whole range from the daily buckets so that summing buckets reproduces the range aggregate exactly through one shared aggregation path; range cost propagates unavailability across every included request per ADR 0003.
4. Provide an exact-match multi-select model filter predicate over the stored `model` field: repeated identifiers, no normalization or aliasing, empty selection matches everything (ADR 0014).
5. Unit tests cover: DST-spanning ranges, `from == to` single-day windows, unpriced-request propagation at both bucket and range levels, bucket-sums-equal-range-total as a property across randomized fixtures, multi-select filter matching including unmatched values, and records outside any requested window being excluded.
6. `pnpm verify` passes.

## Lane

Owns `packages/core/**`. Must not touch `server/**`, `apps/admin/**`, `proxy/**`, or `docs/**`.
