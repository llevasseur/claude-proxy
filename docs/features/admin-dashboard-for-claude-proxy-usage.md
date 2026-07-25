---
type: feature
title: Admin dashboard for claude-proxy usage
description: A local web dashboard that monitors Claude Code usage, context size, sessions, cache savings, and advice from the proxy's audit logs.
tags: [dashboard, usage, trends, advice]
timestamp: 2026-07-24
---

# Admin dashboard for claude-proxy usage

## Summary

A local, single-user web dashboard that reads the proxy's `.audit.json` sidecars —
plus an archive of finalized digests for days the live `logs/` dir no longer holds —
and shows token burn & estimated cost, context-bloat culprits, day-over-day trends,
session transcripts, cache savings, and deterministic coaching advice.

## Motivation

The proxy already captures every request and its token accounting, but the data
only lived as thousands of Markdown/JSON files. This turns that pile into an
at-a-glance view of where context and money are going, and what to do about it.
It is the live, browsable counterpart to the daily end-of-day summary specced in
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
- **Sessions** (`/sessions`) — per-thread transcripts, listed live over SSE, with a detail
  page and its errored tool calls. See [Session transcripts](session-transcripts.md).
- **Live graph** (`/sessions/graph`) — a full-bleed graph of sessions and their subagent
  branches, refreshed on a 4-second poll (this page does not use SSE). See
  [Live session graph](live-session-graph.md).
- **Hooks & Plugins** (`/hooks-plugins`) — the hooks and plugins the device's settings
  declare. The last three stations share one doc: [Config inventory](config-inventory.md).
- **Advice** (`/advice`) — coaching cards derived deterministically from the day's digest
  (dominant tool, tool overhead, low cache-hit, large system prompt, high cost).

Each station carries a [lucide](https://lucide.dev) icon. A toggle in the rail head
collapses the rail to a 64px icon-only strip and back; the choice is persisted in
`localStorage` under `admin:rail-collapsed`, so it survives a reload. Collapsed labels
stay in the accessibility tree (visually hidden, not removed) and surface as hover
tooltips. Below 860px the rail already folds into a top bar, where collapsing means
nothing — there the toggle is hidden and the persisted state is ignored.

Data comes from the `server` API — 22 read-only routes (20 JSON plus the two SSE streams
`/api/sessions/stream` and `/api/sessions/session/stream`) — which computes everything via
`packages/core`. Advice is produced by a `HeuristicAdviceProvider` behind an
`AdviceProvider` seam, so an LLM/agent-backed provider can replace it later without
changing the UI or API.

## Acceptance criteria

- [x] `pnpm install` wires the workspace; `pnpm -r typecheck` and `pnpm -r test` pass.
- [x] `packages/core` unit tests cover digest, cost, and advice.
- [x] `server` serves `/api/*` over the real `logs/` dir; the dashboard renders
      token burn, trends, tool bloat, and advice from live data.
- [x] The proxy still runs with bare `node proxy/proxy.mjs` (zero deps).
- [x] `okq validate` passes on this bundle.

## Open questions

- Whether advice graduates from heuristics to an in-repo `agents/` LLM provider
  (the interface is ready; wiring is out of scope for the first cut).
