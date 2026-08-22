# Task 07 — Server history/trends API

## Goal

Expose Car over HTTP: history record listing, trends, calendar-date ranges,
model filters, and an SSE data-version signal. Blocked by task 06.

## Criteria

1. Durable history as a paginated record listing (inherited codex-proxy ADR 0015 semantics): stable ordering, cursor or offset pagination, per-record sanitized fields only.
2. Trends endpoint returns report-timezone daily buckets for a requested range via core's shared aggregation path.
3. Ranges expressed as calendar dates on the new endpoints (inherited codex-proxy ADR 0011 semantics); invalid ranges rejected with typed errors.
4. Exact multi-select model filter parameter wired to core's filter.
5. SSE stream extended with a data-version signal (inherited codex-proxy ADR 0012) so clients detect new history without polling.
6. Bike endpoints unchanged and regression-tested; SQLite remains rebuildable — all queries served from the disposable view.
7. Vitest coverage: pagination stability across inserts, DST boundary buckets, filter combinations, version-signal monotonicity, rebuild equivalence with history present.
8. `pnpm verify` green.

## Out of scope

Admin routes (task 08); body capture (task 09).
