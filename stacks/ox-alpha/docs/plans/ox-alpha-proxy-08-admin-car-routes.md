# Task 08 — Admin History and Trends routes

## Goal

Add Car surfaces to the dashboard, closing the Car phase boundary. Blocked by
task 07.

## Criteria

1. History route: paginated record listing consuming the server's pagination contract; loading, empty, and error states.
2. Trends route: daily bucket visualization for a selected calendar-date range with timezone-correct labels; unavailable-cost buckets rendered as explicitly unavailable, never zero.
3. Model multi-select filter wired to the exact-match parameter; empty selection means all.
4. SSE data-version signal triggers refetch without reload; live Overview route unchanged.
5. Component/integration tests for pagination navigation, filter application, DST-labeled buckets, version-triggered refresh, and Bike regression coverage.
6. `pnpm verify` green — this ticket completes the Car phase boundary: record a "live validation outstanding" note per ADR 0011 in the PR body.

## Out of scope

Inspection UI (task 10); parity matrix work (task 11).
