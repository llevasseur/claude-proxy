---
type: adr
title: Monorepo with pnpm, TanStack, and Node
description: Restructure the single-file proxy repo into a pnpm monorepo with a Node API and a TanStack dashboard.
tags: [architecture, monorepo, frontend, backend]
timestamp: 2026-07-15
---

# Monorepo with pnpm, TanStack, and Node

## Status

Accepted.

## Context

`claude-proxy` began as a single zero-dependency `proxy.mjs` that logs every
Claude Code request and writes an `.audit.json` sidecar per request. We want an
admin dashboard over that data — usage, trends, and advice via daily summaries —
which needs a frontend, a backend API, and shared analysis logic. A single file
can't carry three concerns, and the analysis logic must be testable in isolation.

## Decision

Restructure into a **pnpm workspace** with four packages:

- `proxy/` — the existing capture proxy, unchanged and still zero-dependency.
- `packages/core/` — pure, unit-tested TypeScript: digest, cost, and advice.
- `server/` — a read-only Node API over the logs, plus a headless daily-summary CLI.
- `apps/admin/` — a **TanStack** (Router + Query) + Vite dashboard.

pnpm over npm/Turborepo: fast, first-class workspaces, no orchestration layer
needed for four packages. TanStack + Node was the requested stack. The proxy
stays plain `.mjs` to preserve its "runs with bare `node`" guarantee.

## Consequences

- Analysis logic is shared and tested once (`packages/core`), consumed by both
  the API and the CLI.
- The proxy and the analysis server are separate processes that communicate only
  through the `logs/` directory — the proxy never gains dependencies or crash risk.
- One workspace install (`pnpm install`) wires everything; `pnpm -r typecheck/test`
  covers the repo.
- New surface area (a build step, a frontend) is added to a formerly trivial repo.

See the full design in
[`superpowers/specs/2026-07-15-monorepo-admin-dashboard-design.md`](../superpowers/specs/2026-07-15-monorepo-admin-dashboard-design.md).
