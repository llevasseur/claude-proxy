# Task 12 — Plane parity implementation of remaining rows

## Goal

Close every row the expansion left unresolved by implementing it or recording
its final evidence-backed rationale. Blocked by task 11.

## Criteria

1. Work the expanded matrix top to bottom; change a row to `implemented` only with concrete evidence — a test name, an endpoint path, a route, or recorded operational output.
2. Adapt applicable capabilities to OpenAI Responses semantics preserving user-visible outcomes of the pinned claude-proxy commit `cc25696504e724bd78824e639e97a0a1d846abea` (ADR 0008); a category summary is not parity.
3. Rows that are genuinely protocol-inapplicable close `N/A` with row-specific rationale — not bulk rationale.
4. Preserve every Bike, Car, and Boat outcome and privacy default; regression tests stay green throughout.
5. Headless paths exist for ingest/backfill/retention/archive/recovery operations where the matrix requires them (headless commands, not browser-only).
6. The immutable comparison point stays the pinned commit; no scope from later claude-proxy commits.
7. `pnpm verify` green after each coherent group of rows; final state has zero `unresolved` rows in the matrix.

## Out of scope

Final verification sweep and operational-doc completeness audit (task 13).
