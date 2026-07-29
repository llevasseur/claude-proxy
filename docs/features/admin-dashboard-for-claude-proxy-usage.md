---
type: feature
title: Admin dashboard for claude-proxy usage
description: A local web dashboard that monitors Claude Code usage, context size, sessions, cache savings, and advice from the proxy's audit logs.
tags: [dashboard, usage, trends, advice]
timestamp: 2026-07-24
---

# Admin dashboard for claude-proxy usage

## Summary

A local, single-user dashboard over the proxy's `.audit.json` sidecars and
finalized-digest archive, showing token burn and estimated cost, context bloat,
day-over-day trends, transcripts, cache savings, and deterministic advice.

## Motivation

The proxy's request and token records otherwise live in thousands of Markdown/JSON
files. This is the browsable counterpart to the end-of-day summary in
[`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md),
and was designed in
[`2026-07-15-monorepo-admin-dashboard-design.md`](../specs/2026-07-15-monorepo-admin-dashboard-design.md).

## Behavior

Twelve stations in the side rail, several with drill-down subpages beneath them:

- **Overview** (`/`) — today's real input / output tokens, estimated cost, cache-hit
  ratio, request count, busiest hour, tool overhead, and average system prompt, each
  with a day-over-day delta and a 7/14/30-day sparkline.
- **Trends** (`/trends`) — per-day tokens and cost over a 7/14/30-day window (bar
  charts + table), a tokens-per-request line chart, and a per-metric drill-down
  (`/trends/$metric`).
- **Context size** (`/context`) — how large the prompt to the model gets, and why the
  largest was so large. See [Context-size analytics](context-size-analytics.md) and
  [Message drill-down](message-drill-down.md).
- **Tool bloat** (`/tools`) — every tool ranked by bytes / est-tokens / share of the request.
- **Skim** (`/skim`) — the proxy's opt-in reply cache: hit rate over time, tokens and
  dollars saved, and the most-repeated request shapes. See
  [Skim response cache](skim-response-cache.md).
- **Not added** (`/withheld`) — tools the device's settings keep out of every request,
  cross-referenced against tools recently observed in traffic.
- **Proxy filters** (`/filters`) — the inventory of what the proxy itself strips, because
  the CLI cannot be configured to.
- **Projects** (`/projects`) — per-project auto-memory files, with a page per project and
  per memory. See [Project memory browser](project-memory-browser.md).
- **Sessions** (`/sessions`) — a two-pane chat client over per-thread transcripts, listed
  live over SSE, with controls to start and continue local agent sessions plus detail and
  error pages. See [Session transcripts](session-transcripts.md) and
  [Dashboard chat sessions](dashboard-chat-sessions.md).
- **Live graph** (`/sessions/graph`) — a full-bleed graph of sessions and their subagent
  branches, refreshed on a 4-second poll (this page does not use SSE). See
  [Live session graph](live-session-graph.md).
- **Hooks & Plugins** (`/hooks-plugins`) — the hooks and plugins the device's settings
  declare. The last three stations share one doc: [Config inventory](config-inventory.md).
- **Advice** (`/advice`) — coaching cards derived deterministically from the day's digest
  (dominant tool, tool overhead, low cache-hit, large system prompt, high cost), plus
  ten-session suggestion buckets with persistent pending/done/skipped flags. See
  [Session suggestions](session-suggestions.md).

Each station has a [lucide](https://lucide.dev) icon. The rail toggles between full and
a 64px icon-only strip; `localStorage` key `admin:rail-collapsed` persists the choice.
Collapsed labels remain visually hidden in the accessibility tree and appear as hover
tooltips. Below 860px, the rail becomes a top bar: the toggle and persisted state are
ignored, while icons remain beside labels.

Day-bucketed values use `REPORT_TZ` (`America/New_York`, following EST/EDT), so
Overview, Trends, busiest hour, and Skim roll over at Eastern midnight, not the UTC
filename date. `readArchivedDay` merges the two UTC archive folders a reporting day can
span, then filters by sidecar timestamp. Individual events use the viewer's local zone.

Most `server` routes are read-only JSON views; two SSE streams feed session list/detail.
An explicit POST allowlist with origin-checked CORS starts, continues, stops, or ends
dashboard chats and records suggestion flags. See
[ADR 0003](../adrs/0003-allow-narrowly-scoped-writes-in-the-local-server.md).
Analysis is computed via `packages/core`. Advice is produced by a
`HeuristicAdviceProvider` behind an `AdviceProvider` seam, so an LLM/agent-backed provider
can replace it later without changing the UI or API.

## Acceptance criteria

- [x] `pnpm install` wires the workspace; `pnpm -r typecheck` and `pnpm -r test` pass.
- [x] `packages/core` unit tests cover digest, cost, and advice.
- [x] `server` serves `/api/*` over the real `logs/` dir; the dashboard renders
      token burn, trends, tool bloat, and advice from live data.
- [x] The proxy still runs with bare `node proxy/proxy.mjs` (zero deps).
- [x] Day buckets and busiest-hour labels use `America/New_York`, including the EST/EDT
      boundary and late-evening requests whose UTC date is already the next day.
- [x] `okq validate` passes on this bundle.

## Open questions

- Whether to replace heuristics with an in-repo `agents/` LLM provider; the interface
  exists, but wiring was out of scope.
