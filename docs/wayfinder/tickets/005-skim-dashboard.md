---
id: "005"
title: "Future phase — Skim dashboard page to study results"
map: map-proxy-skim
labels: [wayfinder:prototype]
assignee: null
blockedBy: ["001"]
status: open
---

## Question

The named future phase: a dashboard page to **study** whether the skim is worth
keeping. Build on the existing stack — `packages/core` (pure digest), `server/`
(read-only API over sidecars), `apps/admin` (TanStack + Vite routes):

- **core** — extend the digest to aggregate the `skim` sidecar fields from ticket
  001: hit count, miss count, hit-rate, `savedInputTokens` summed, estimated
  dollars saved (reuse `pricing.ts`). Unit-tested like the rest of core.
- **server** — a `GET /api/skim?date=` (and/or trend) route returning that
  aggregate.
- **admin** — a "Skim" route rendering hit-rate over time, cumulative $ saved,
  and top repeated request shapes, matching the existing route style
  (StatCard / SeriesLineChart / BarChart).

Blocked by 001 (needs the sidecar `skim` fields to exist and accumulate). This is
the phase the user explicitly asked to include; it stays a decision-then-build
ticket, not part of the core destination.
