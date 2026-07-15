---
type: feature
title: Admin dashboard for claude-proxy usage
description: A local web dashboard that monitors Claude Code usage, trends, and advice from the proxy's audit logs.
tags: [dashboard, usage, trends, advice]
timestamp: 2026-07-15
---

# Admin dashboard for claude-proxy usage

## Summary

A local, single-user web dashboard that reads the proxy's `.audit.json` sidecars
and shows token burn & estimated cost, context-bloat culprits, day-over-day
trends, and deterministic coaching advice.

## Motivation

The proxy already captures every request and its token accounting, but the data
only lived as thousands of Markdown/JSON files. This turns that pile into an
at-a-glance view of where context and money are going, and what to do about it.
It is the live, browsable counterpart to the daily end-of-day summary specced in
`2026-07-13-claude-usage-summary-design.md`.

## Behavior

- **Overview** — today's real input / output tokens, estimated cost, cache-hit
  ratio, request count, busiest hour, and tool overhead, each with a
  day-over-day delta.
- **Trends** — per-day tokens and cost over a 7/14/30-day window (bar charts + table).
- **Tool bloat** — every tool ranked by bytes / est-tokens / share of the request.
- **Advice** — coaching cards derived deterministically from the day's digest
  (dominant tool, tool overhead, low cache-hit, large system prompt, high cost).

Data comes from the `server` API (`/api/summary`, `/api/trends`, `/api/tools`),
which computes everything via `packages/core`. Advice is produced by a
`HeuristicAdviceProvider` behind an `AdviceProvider` seam, so an LLM/agent-backed
provider can replace it later without changing the UI or API.

## Acceptance criteria

- [x] `pnpm install` wires the workspace; `pnpm -r typecheck` and `pnpm -r test` pass.
- [x] `packages/core` unit tests cover digest, cost, and advice.
- [x] `server` serves `/api/*` over the real `logs/` dir; the dashboard renders
      token burn, trends, tool bloat, and advice from live data.
- [x] The proxy still runs with bare `node proxy/proxy.mjs` (zero deps, unchanged).
- [x] `okq validate` passes on this bundle.

## Open questions

- Whether advice graduates from heuristics to an in-repo `agents/` LLM provider
  (the interface is ready; wiring is out of scope for the first cut).
