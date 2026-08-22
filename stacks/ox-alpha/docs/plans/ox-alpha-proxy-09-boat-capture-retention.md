# Task 09 — Boat opt-in body capture with redaction and retention

## Goal

Add explicit opt-in request/response body capture with tested redaction and
retention controls. Blocked by the Car boundary (tasks 01–08 merged).

## Criteria

1. Capture defaults OFF at the proxy; enabling requires explicit configuration; with capture off, behavior is byte-identical to Bike/Car and no body bytes touch disk anywhere.
2. Captured bodies are stored separately from sanitized sidecars; sidecar v1 schema unchanged — no new fields.
3. Redaction: tested rules remove credentials, cookies, authorization material, and configurable patterns from captured bodies before persistence; tests prove secrets never survive capture when enabled.
4. Retention controls: configurable retention window and size caps with a deletion path; deletion verified by tests; expired capture data is removed by server-side maintenance, headless-invocable.
5. Server accepts capture files only when its own opt-in flag matches; a proxy capturing while the server has capture disabled does not corrupt ingest or Bike/Car summaries.
6. Bike and Car outcomes remain fully useful with zero inspection data present (tests cover this).
7. Update durable privacy/retention docs (`docs/features/`, spec section) describing defaults, redaction scope, retention semantics.
8. `pnpm verify` green.

## Out of scope

Inspection APIs/UI (task 10); operator automation (excluded per ADR 0004).
