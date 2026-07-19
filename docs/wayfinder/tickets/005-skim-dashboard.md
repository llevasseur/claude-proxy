---
id: "005"
title: "Future phase — Skim dashboard page to study results"
map: map-proxy-skim
labels: [wayfinder:prototype]
assignee: claude
blockedBy: ["001"]
status: closed
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

## Resolution

Built the "study the skim" dashboard across all three existing layers, reading
the real ticket-001 sidecar `skim` block (`enabled`, `servedFromCache`,
`savedInputTokens`, `cacheKey`).

- **core** (`packages/core/src/skim.ts`): `AuditSkim` type (optional on
  `AuditSidecar`, so pre-001 sidecars are tolerated) plus pure
  `computeSkimDigest` / `skimDigestsByDay`. Aggregates hit count, miss count
  (enabled-but-not-served), hit-rate over enabled traffic, summed
  `savedInputTokens`, estimated dollars saved (each hit's saved input tokens
  priced at its model's input rate via `pricing.ts`), and top repeated request
  shapes grouped by `cacheKey`. Unit-tested in `test/skim.test.ts` (8 cases)
  matching the existing digest-test style.
- **server** (`server/src/api.ts`, `server/src/server.ts`): read-only
  `GET /api/skim?date=` (one-day aggregate) and `GET /api/skim/trend?days=`
  (per-day series), matching the existing route/handler style.
- **admin** (`apps/admin/src/routes/skim.tsx` + router/api wiring): a "Skim"
  station rendering hit-rate over time and cumulative $ saved
  (`SeriesLineChart`), top repeated request shapes (`BarChart` + table), and
  headline `StatCard`s (hit-rate, saved today, saved over window, saved tokens).

**Verified:** `pnpm -r typecheck` (core + server + admin all pass);
`pnpm --filter @claude-proxy/core test` (37 passed, incl. 8 new skim tests);
and an end-to-end smoke of `buildSkim`/`buildSkimTrend` against a synthesized
sidecar fixture (1 hit + 1 miss → 50% hit-rate, 9,100 saved tokens = $0.1365 at
the opus input rate, both requests grouped under one shape).
