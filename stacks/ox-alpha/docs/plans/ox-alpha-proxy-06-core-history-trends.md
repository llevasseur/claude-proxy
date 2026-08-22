# Task 06 — Core history, trends and filters domain

## Goal

Extend `@ox-alpha-proxy/core` with deterministic history, trend, range, and
filter computation — pure functions only. Blocked by the Bike boundary
(tasks 01–05 merged).

## Criteria

1. `resolveCalendarRange`: optional inclusive `from`/`to` calendar dates resolved against an explicit timezone into half-open UTC instants, DST-aware.
2. `aggregateDailyBuckets`: complete per-day aggregates with ADR 0003 cost semantics propagated independently per bucket; window boundaries exact.
3. `aggregateRangeFromBuckets`: range totals derived through one shared path so bucket sums equal range totals.
4. `modelFilter`/`selectByModels`: exact multi-select model identifier filtering; empty selection matches all (inherited codex-proxy ADR 0014 semantics).
5. History record projection: sanitized per-record values suitable for a paginated listing.
6. All functions stay deterministic — explicit timezone/clock arguments, no Node imports.
7. Vitest coverage including DST spring/autumn days, single-day windows, unpriced propagation at both levels, filter edge cases.
8. `pnpm verify` green.

## Out of scope

Server endpoints (task 07); admin UI (task 08); Boat capture.
