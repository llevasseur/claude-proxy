# Task 05 — Admin Overview dashboard

## Goal

Build `apps/admin`: one live Overview page proving Bike independently useful,
closing the Bike phase. Blocked by task 04.

## Criteria

1. React/TanStack app bootstraps from `/api/health` and `/api/summary`, subscribes to `/api/events` SSE, and periodically refetches as a backstop.
2. Overview shows Today in the report timezone: request count, input tokens, output tokens, total tokens, latest activity, and cost as a complete estimate or an explicit unavailable state — never `$0` for unknown cost (ADR 0003).
3. Retains shell and last known summary through reconnecting, stale, degraded, and unavailable states; no reload needed for updates.
4. Vite dev setup reads its own `.env`; build produces the admin bundle for the root build gate.
5. Component tests or integration tests cover state transitions (live/reconnecting/stale/degraded/unavailable) and cost-unavailable rendering.
6. `pnpm verify` green end to end — this ticket completes the Bike phase boundary: record a "live validation outstanding" note per ADR 0011 in the PR body.
7. Update `docs/features/bike.md` links if run instructions changed; durable docs otherwise already describe this outcome.

## Out of scope

History/Trends routes (task 08); inspection UI (task 10).
