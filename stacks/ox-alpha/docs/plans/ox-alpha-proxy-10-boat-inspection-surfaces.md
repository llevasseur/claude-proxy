# Task 10 — Context, tool, prompt and session inspection surfaces

## Goal

Build Boat's inspection APIs and dashboard routes over captured bodies, closing
the Boat phase boundary. Blocked by task 09.

## Criteria

1. Inspection endpoints over capture data only: context/message inspection, tool schema and tool-call listing, prompt analysis, session grouping — each degrading gracefully (typed empty result) when no capture exists.
2. Memoized day inspection on the server for expensive per-day context assembly (inherited codex-proxy `context-day-memo` pattern), invalidated by retention deletion and capture changes.
3. Pagination on every listing endpoint; sanitized metrics endpoints untouched.
4. Dashboard routes for each inspection surface with loading/empty/no-capture states explaining that Boat capture is off.
5. Every endpoint remains fully functional in a repository where capture was never enabled (integration tests run both modes).
6. Update `docs/features/` with a Boat feature record; roadmap matrix rows for tool/context inspection may advance only after this ticket merges with evidence.
7. `pnpm verify` green — this ticket completes the Boat phase boundary: record a "live validation outstanding" note per ADR 0011 in the PR body.

## Out of scope

Operator automation/coaching (ADR 0004 exclusion); parity matrix expansion (task 11).
