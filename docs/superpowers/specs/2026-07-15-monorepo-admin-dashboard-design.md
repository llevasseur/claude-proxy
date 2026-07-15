# Monorepo + Admin Dashboard — Design Spec

**Date:** 2026-07-15
**Status:** Approved (brainstorming complete)
**Builds on:** [`docs/2026-07-13-claude-usage-summary-design.md`](../../2026-07-13-claude-usage-summary-design.md)

## Goal

Turn the single-file `claude-proxy` repo into a **pnpm monorepo** with a **Node API backend**
and a **TanStack admin dashboard frontend**. The dashboard reads the `.audit.json` sidecars the
proxy already writes and surfaces **usage, trends, and advice** — the same four insight areas as
the daily-summary spec (token burn & cost, context-bloat culprits, activity, coaching), but as a
live browser dashboard rather than a once-daily macOS notification.

The proxy stays a transparent, zero-dependency pass-through (unchanged behavior). All new analysis
is read-only over the logs it produces. No credentials are ever read or stored.

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
        advice.ts             AdviceProvider seam + deterministic heuristics
        index.ts
      test/                   vitest unit tests + fixtures
  server/                     Node API over the logs dir (uses packages/core)
    src/
      logs.ts                 read + parse audit sidecars from LOG_DIR
      routes.ts               request handling
      server.ts               http server entry
      daily-summary.ts        headless daily job entry (reuses core)
  apps/
    admin/                    Vite + TanStack Router + TanStack Query dashboard
      src/...
  docs/                       okq OKF bundle (adrs/ + features/) + design specs
  logs/                       proxy capture output (gitignored)
```

**Why proxy and server are separate packages:** they are separate processes with separate
concerns. The proxy is a load-bearing, always-up, zero-dep pass-through that must never gain
dependencies or crash risk. The server is a read-only analysis API that can restart freely. They
communicate only through the `logs/` directory on disk.

## Package manager & tooling

- **pnpm workspaces** (pnpm 11, installed). Root `package.json` declares workspaces; each package
  has its own `package.json`. No Turborepo — 4 packages don't need a task-graph orchestrator; root
  scripts fan out with `pnpm -r`.
- **TypeScript** for `packages/core`, `server`, and `apps/admin`. The proxy stays plain `.mjs`
  (zero-dep, no build step) to preserve its "runs with bare `node`" guarantee.
- **vitest** for unit tests (fast, TS-native, works in `packages/core`).

## Component design

### `packages/core` — pure analysis library (the heart, fully tested)

Extracts the deterministic logic from the daily-summary spec into a reusable, unit-tested module.

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
- **`advice.ts`** — an `AdviceProvider` interface (`advise(digest) -> Advice[]`) and a
  `HeuristicAdviceProvider` implementation: deterministic rules over the digest (e.g. "tool X is N%
  of every request — disable it if unused", "cache-hit ratio low — reuse sessions", "system prompt
  is large"). Each `Advice` has `severity`, `title`, `detail`, and the `metric` it derives from.
  **Seam:** the interface lets a future `agents/`-backed provider (LLM coaching, replacing the
  external test-eve wiring) drop in without touching callers.

### `server` — Node API over the logs

- Reads `.audit.json` sidecars from `LOG_DIR` (env, default `../logs` relative to repo root, i.e.
  the proxy's real output dir). Uses `packages/core` for all computation.
- Built on **Node's built-in `http`** with a tiny router (keeps deps minimal, matches repo ethos;
  no framework needed for a handful of read-only JSON routes). CORS enabled for the dev SPA.
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

- **Vite + React + TanStack Router (file/route tree) + TanStack Query** (data fetching/caching).
- Talks to the server API (base URL via `VITE_API_BASE`, default `http://localhost:8788`).
- Views:
  - **Overview** — today's token burn & est. cost, cache-hit ratio, request count, busiest hour,
    with day-over-day deltas.
  - **Trends** — a multi-day line/bar chart of tokens & cost (lightweight SVG charts, no heavy
    charting dep unless one is clearly warranted).
  - **Tool bloat** — the ranked tool table (bytes / est-tokens / % of request), the proxy's hero view.
  - **Advice** — the coaching cards from the `AdviceProvider`.
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

- LLM/eve-backed advice (seam left; not wired in this PR).
- Auth on the dashboard (local-only, single-user; bind localhost).
- launchd/deployment automation (documented, not scripted here — carried by the 2026-07-13 spec).
- Session-level attribution (no session ID in logs), weekly rollups, remote delivery.
