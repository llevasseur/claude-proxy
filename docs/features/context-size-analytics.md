---
type: feature
title: Context-size analytics
description: A dashboard page showing how large the prompt sent to the model gets — average, largest, and why the largest was so large.
tags: [context-size, usage, dashboard]
timestamp: 2026-07-24
---

# Context-size analytics

## Summary

A "Context size" page in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md)
that answers three questions about how large the prompt sent to the model gets:
**what is the average context size, when was it largest, and why was the largest so
large.** The "why" is a raw-data drill-down for any of the largest requests. Designed in
[`2026-07-21-context-size-analytics-design.md`](../specs/2026-07-21-context-size-analytics-design.md).

## Motivation

The proxy already records, per request, the true prompt size that fills the model's
context window (`tokens.realInput` = input + cache-read + cache-creation) plus the byte
sizes of the system prompt, each tool schema, and the full request body. Nothing surfaced
*how big context gets over time* or *what made a given request so large* — a recurring
question when a session feels heavy or costs spike. This turns the already-captured data
into a direct answer without touching the passive-observer proxy.

## Behavior

- **Metric** — context size is `realInput` tokens, the true prompt size sent to the model.
- **Context size page** (`/context`) — a 7/14/30-day window selector, stat tiles for
  **average / median / largest** context (tokens per request) and the request count, and a
  **"Requests"** table listing every request in the window where each row links to its
  breakdown. Default order is **When** newest-first; sortable by **When**, **Model**,
  **Real input**, **System**, **Tools**, and **Size** (click a column to sort and again to
  flip direction). The peak request is tagged in place.
- **Request breakdown** (`/context/$file`) — the "why so large" drill-down for one captured
  request: totals (bytes, message count, tool count), a **region table** (conversation
  messages vs. tool schemas vs. system prompt as shares of the request), a
  **messages-by-size** table (each row opens the [Message drill-down](message-drill-down.md)
  for that message; the **#** column numbers messages from 1 while the route stays 0-based;
  sortable by **#**, **Bytes**, **~Tokens**, and **Share** — default **#**
  ascending, click a column to sort and again to flip direction), a **tools-by-size** table
  (each row opens that tool's schema page), and the **raw request JSON** (collapsed by
  default, capped at 2 MB). Breadcrumbs link back up to the Context size page.
- **Tool schema page** (`/context/$file/tool/$index`) — one tool schema in full: stat tiles
  for **position** (`#index` of N tools), **name**, and **size** (bytes, ~tokens), then a
  **"Tool schema"** card with a **Pretty** view (name, description, and a required-flagged
  parameter table drawn from `input_schema`) and a **Raw** JSON view.

Data comes from the `server` API — `GET /api/context?days=<n>` (windowed summary; `days` is
clamped to 1–365, default 14), `GET /api/context/detail?file=<base>` (one request's breakdown
+ raw JSON), and `GET /api/context/tool?file=<base>&index=<n>` (one tool schema) — computed via
`summarizeContext` / `analyzeRequestBody` / `extractRequestTool` in `packages/core`. The
drill-down endpoints read exactly one `.request.txt`; the `file` handle is validated and
resolved strictly inside the log directory, so no path traversal is possible.

## Acceptance criteria

- The Context size page shows average, median, and largest `realInput` tokens over the
  selected window, plus the request count.
- The "Requests" table lists every request in the window, ordered by arrival time by default
  and sortable by when, model, real input, system, tools, and size; each row opens its breakdown.
- The breakdown attributes a request's size across conversation messages, tool schemas, and
  the system prompt, and exposes the raw request JSON.
- Each "Tools by size" row opens `/context/$file/tool/$index`, showing that tool's full schema
  (Pretty parameter table or Raw JSON), read from the parsed request body so it resolves even
  when the raw JSON was truncated.
- No proxy changes; the feature is read-only over existing audit sidecars and request logs.
- `packages/core` context helpers are unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Whether to add a historical chart of average/peak context per day (currently avg/median/max
  over a window only — see the design's out-of-scope note).
- Whether to group the largest requests by session id (session id is captured but not
  aggregated here).
