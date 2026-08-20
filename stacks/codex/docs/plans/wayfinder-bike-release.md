---
type: wayfinder
title: Wayfinder — Bike release
description: Ship the smallest complete codex-proxy with live token and cost visibility.
tags: [planning, bike]
timestamp: 2026-08-19
---

# Wayfinder — Bike release

**Slug:** `bike-release`
**Base branch:** `wayfinder/bike-release` (cut from the default branch; every ticket targets it)
**Plans directory:** `docs/plans/`
**Started:** 2026-08-19
**Goal:** Ship a private, clone-and-run Bike release that transparently proxies Codex traffic and shows today's live input tokens, output tokens, and cost.

> Ephemeral scaffolding, deleted when the wayfinder closes. The durable output is
> the merged code and the repository's feature, spec, roadmap, and decision docs.

## Delivery waves

1. Build the repository foundation, pure usage core, and durable roadmap.
2. Build the proxy and server in parallel against the core contract.
3. Build and visually verify the Overview dashboard against the server API.

The owned paths in the four plans are disjoint. A ticket MUST NOT edit another
ticket's owned paths. If a shared contract needs to change, update task 01 first
and rebase its dependants before dispatch.

## Active tasks

| # | Task | Plan | Branch | Status |
|---|------|------|--------|--------|

## Completed

<!-- newest first; one entry appended per task completion -->

### 04 — overview-dashboard (2026-08-19)

PR #5 shipped the single-route `Overview` under `apps/admin/` with the byte-identical pinned claude-proxy style system, responsive rail/title/theme shell, health/SSE live, reconnecting, stale, and unavailable states, and input-token, output-token, and cost stat cards; the aggregate verifier and real empty/populated/live/unavailable runtime checks passed. Review fixed mobile topbar brand alignment. Visual evidence remains owed: the in-app browser backend returned `[]`, so no screenshots were claimed and desktop/mobile layouts, dark/light themes, drawer behavior, keyboard focus, and reconnecting presentation were not visually verified.

### 02 — transparent-proxy (2026-08-19)

PR #4 shipped zero-runtime-dependency transparent HTTP/SSE streaming forwarding under `proxy/src/`, recognized Responses usage and cost observation, atomic schema-validated sanitized sidecars, live status transitions, `proxy/README.md`, and 16 proxy tests. Review confined absolute-form targets to the configured upstream and made status writes recover after transient filesystem failures. The root changelog was omitted because the ticket's strict lane excluded it; there were no product-scope deviations.

### 03 — live-usage-server (2026-08-19)

PR #3 added the WAL-mode disposable SQLite view, idempotent transactional sidecar ingestion and recovery, rejection diagnostics, health/Today-summary/SSE APIs, shutdown-safe refresh handling, server tests, and `server/README.md`. Manual database deletion/rebuild proof was blocked by the command harness; automated delete/rebuild recovery coverage passed. No changelog was added because the ticket lane excluded shared files.

### 01 — foundation-core-roadmap (2026-08-19)

PR #2 established the pnpm/TypeScript workspace and package boundaries, added pure usage normalization, pricing, sanitized-sidecar validation, Today aggregation, and tests under `packages/core/`, and published the Bike feature/spec plus the copy-ready Bike-to-Plane roadmap under `docs/`. No planned scope moved forward: proxy forwarding, server storage/API, and dashboard behavior remain in tasks 02–04.

## Agent kickoff prompt

Read the repository instructions, the installed wayfinder workflow, and
`docs/plans/wayfinder-bike-release.md`. Inspect live Git and worktree state.
Select the next unblocked active task, then run the task workflow against its
plan with `wayfinder/bike-release` as the base branch. Retarget the resulting
pull request to `wayfinder/bike-release`, confirm the retarget landed, and stop
after opening the pull request.
