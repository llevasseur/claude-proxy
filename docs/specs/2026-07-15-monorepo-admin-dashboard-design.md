---
type: design
title: Monorepo + Admin Dashboard — Design Spec
description: Turn the single-file proxy into a pnpm monorepo with a Node API and a TanStack admin dashboard.
tags: [monorepo, dashboard, design, architecture]
timestamp: 2026-07-15
scope: claude
---

# Monorepo + Admin Dashboard — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstorming complete)
**Builds on:** [`docs/2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md)
**Decision record:** [`adrs/0002-monorepo-with-pnpm-tanstack-and-node.md`](../adrs/0002-monorepo-with-pnpm-tanstack-and-node.md)

**Current state (2026-07-28):** shipped with several departures. The zero-dependency,
bare-`node` proxy now strips `EndConversation` and harness-injected reminders
(`proxy/proxy.mjs`, `packages/core/src/filters.ts`). Session attribution was added via
`proxy/session.mjs`, `packages/core/src/sessions.ts`, and `/api/sessions*`; see
[Session transcripts](../features/session-transcripts.md). The proxy has a `node --test`
suite, and `server/` now carries its own vitest suite, so `packages/core` is no longer the
only tested code. The server grew beyond these four read-only routes to an explicit write
allowlist — chat, suggestion status, job delete, and the device system prompt — superseding
ADR 0002's read-only clause; see
[ADR 0003](../adrs/0003-allow-narrowly-scoped-writes-in-the-local-server.md), which records
only the first two of those four. Reads are no longer a directory scan either: they are
served from a SQLite view of `logs/` by default, one flag away from the original scan; see
[ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md).
The [dashboard feature](../features/admin-dashboard-for-claude-proxy-usage.md) tracks
current behavior; the rest is point-in-time design history.

## Goal

Turn `claude-proxy` into a **pnpm monorepo** with a **Node API** and **TanStack
dashboard** over its `.audit.json` sidecars, surfacing the daily-summary spec's four
areas—token burn/cost, context bloat, activity, and coaching—in a live browser.

The proxy stays a transparent, zero-dependency pass-through (unchanged behavior). All new
analysis is read-only over the logs it produces. No credentials are ever read or stored.

## Repository layout

```
claude-proxy/                 (monorepo root — pnpm workspaces)
  package.json                root scripts + workspaces
  pnpm-workspace.yaml         apps/*, packages/*, proxy, server
  tsconfig.base.json          shared TS compiler options
  proxy/                      the capture proxy (moved proxy.mjs; zero-dep, unchanged)
    package.json
    proxy.mjs
  packages/
    core/                     shared, pure, unit-tested TS library
      src/
        types.ts              AuditSidecar shape (matches proxy output)
        pricing.ts            editable $/MTok price map + cost()
        digest.ts             audit sidecars -> UsageDigest (pure)
        advice.ts             deterministic advice heuristics
        index.ts
      test/                   vitest unit tests + fixtures
  server/                     Node API over the logs dir (uses packages/core)
    src/
      logs.ts                 read + parse audit sidecars from LOG_DIR
      api.ts                  request handling (shipped as api.ts, not routes.ts)
      server.ts               http server entry
      daily-summary.ts        headless daily job entry (reuses core)
  apps/
    admin/                    Vite + TanStack Router + TanStack Query dashboard
      src/...
  docs/                       okq OKF bundle (adrs/, features/, specs/, wayfinder/)
  logs/                       proxy capture output (gitignored)
```

**Why proxy and server are separate:** the load-bearing, always-up, zero-dependency
proxy must not gain dependencies or crash risk; the read-only analysis server can restart.
They communicate only through `logs/`.

## Package manager & tooling

- **pnpm workspaces** (pnpm 11, installed). Root and package `package.json` files define
  workspaces; four packages need no Turborepo, and root scripts use `pnpm -r`.
- **TypeScript** for `packages/core`, `server`, and `apps/admin`. The proxy stays plain `.mjs`
  (zero-dep, no build step) to preserve its "runs with bare `node`" guarantee.
- **vitest** for unit tests (fast, TS-native, works in `packages/core`).

## Component design

### `packages/core` — pure analysis library (the heart, fully tested)

Reusable, unit-tested deterministic logic from the daily-summary spec.

- **`types.ts`** — the `AuditSidecar` TypeScript type, matching exactly what `proxy.mjs` writes
  (`timestamp`, `model`, `endpoint`, `statusCode`, `tokens{…}`, `request{…}`, `tools[]`).
- **`pricing.ts`** — an editable `Record<modelPrefix, {input, output, cacheWrite, cacheRead}>` price
  map in `$/MTok`, plus `estimateCost(tokens, model)`. Explicitly approximate; matched by longest
  model-name prefix with a sane fallback.
- **`digest.ts`** — `computeDigest(sidecars, { date, priorDigest? }) -> UsageDigest`. Pure function.
  `UsageDigest` mirrors the daily-summary spec: `requestCount`, `models`, `tokens` (incl.
  `cacheHitRatio`), `cost`, `topTools`, `avgSystemPromptBytes`, `toolOverheadPctOfInput`,
  `busiestHour`, optional `trend[]` vs a prior digest, and a `skipped` tally for malformed input.
  Also exposes `digestsByDay(sidecars) -> UsageDigest[]` for the multi-day trend view.
- **`advice.ts`** — `heuristicAdvice.advise(digest) -> Advice[]`: deterministic rules over the
  digest (e.g. "tool X is N% of every request — disable it if unused", "cache-hit ratio low —
  reuse sessions", "system prompt is large"). Each `Advice` has `severity`, `title`, `detail`,
  and the `metric` it derives from. Callers depend on the concrete rule set; the interface this
  spec once described has been deleted, since a second implementation never arrived.

### `server` — Node API over the logs

- Reads `.audit.json` sidecars from `LOG_DIR` (env, default `../logs` relative to repo root, i.e.
  the proxy's real output dir). Uses `packages/core` for all computation.
- Built on **Node's built-in `http`** with a tiny router; no framework is needed for four
  read-only JSON routes. CORS is enabled for the dev SPA.
- Routes (all `--json`-style, read-only):
  - `GET /api/health` — liveness + resolved `LOG_DIR` + sidecar count.
  - `GET /api/summary?date=YYYY-MM-DD` — one day's `UsageDigest` + advice (defaults to today; trend
    vs the prior day computed on the fly).
  - `GET /api/trends?days=N` — per-day digests for the last N days (for charts).
  - `GET /api/tools?date=…` — the ranked tool-bloat table for a day.
- **`daily-summary.ts`** — headless entry (`node/tsx daily-summary.ts`) reusing the same core to
  produce today's digest + advice and print/write it. This is the CLI counterpart to the dashboard
  and the launchd hook point from the 2026-07-13 spec (kept in-repo now instead of test-eve).

### `apps/admin` — TanStack dashboard

- **Vite + React + TanStack Router** (code-defined routes) + **TanStack Query**.
- Talks to the server API (base URL via `VITE_API_BASE`, default `http://localhost:8788`).
- Views:
  - **Overview** — today's token burn & est. cost, cache-hit ratio, request count, busiest hour,
    with day-over-day deltas.
  - **Trends** — a multi-day line/bar chart of tokens & cost (lightweight SVG charts, no heavy
    charting dep unless one is clearly warranted).
  - **Tool bloat** — the ranked tool table (bytes / est-tokens / % of request), the proxy's hero view.
  - **Advice** — the coaching cards from `heuristicAdvice`.
- Styling: minimal, dependency-light (hand-rolled CSS / CSS modules). No design-system dependency.

## Ports

- Proxy: **8787** (unchanged).
- Server API: **8788** (new; avoids the proxy).
- Admin dev server (Vite): **5173** (Vite default).

## Data flow

```
Claude Code ─▶ proxy :8787 ─▶ api.anthropic.com        (reply streamed back)
                  │
                  └─ writes logs/<ts>_anthropic.audit.json  (+ .md, .request.txt)
                                     │
   packages/core (computeDigest / advise)  ◀── reads ──┐
                  │                                     │
      ┌───────────┴───────────┐                    server :8788  ◀── HTTP ── apps/admin (dashboard)
      │                       │                    (/api/*)
 daily-summary.ts        server routes
 (CLI / launchd)         (dashboard API)
```

## Error handling

- **Malformed/partial sidecar** → skipped, counted in `digest.skipped`, surfaced in the API/UI.
  Never aborts a request.
- **Empty log dir / no data for date** → API returns a well-formed empty digest (zeros), UI shows a
  friendly "no activity" state. Not an error.
- **Server can't read LOG_DIR** → `/api/health` reports it; data routes return 500 with a clear
  message the UI renders.
- **Proxy unchanged** → its existing behavior and enterprise-safety guarantees are untouched.

## Testing

- **`packages/core` is the only logic that needs automated tests** (pure functions):
  `computeDigest` (empty day, single request, multi-model, malformed sidecar, trend vs seeded prior
  digest), `estimateCost` (prefix match + fallback), `HeuristicAdviceProvider` (rules fire on the
  right thresholds). vitest + fixtures.
- **server & apps/admin** are I/O / UI — verified by typecheck + build + a manual smoke run against
  the real `logs/` dir. Documented in the root README.

## Success criteria

1. `pnpm install` at the root wires all workspaces; `pnpm -r typecheck` and `pnpm -r test` pass.
2. `packages/core` unit tests pass, covering the digest/cost/advice logic.
3. `server` starts, serves `/api/*` over the real `logs/` dir, and `apps/admin` renders token burn,
   trends, tool bloat, and advice from live data.
4. `okq validate` passes on the `docs/` OKF bundle.
5. The proxy still runs with bare `node proxy/proxy.mjs` — zero deps, behavior unchanged.

## Out of scope (YAGNI)

- LLM/eve-backed advice (not wired in this PR; the seam left for it has since been deleted).
- Auth on the dashboard (local-only, single-user; bind localhost).
- launchd/deployment automation (documented, not scripted here — carried by the 2026-07-13 spec).
- Session-level attribution (no session ID in logs), weekly rollups, remote delivery.
