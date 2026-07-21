---
type: feature
title: Context-size analytics
description: A dashboard page showing how large the prompt sent to the model gets — average, largest, and why the largest was so large.
tags: [context-size, usage, dashboard]
timestamp: 2026-07-21
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
  **"Largest requests"** table (peak first) where each row links to its breakdown.
- **Request breakdown** (`/context/$file`) — the "why so large" drill-down for one captured
  request: totals (bytes, message count, tool count), a **region table** (conversation
  messages vs. tool schemas vs. system prompt as shares of the request), a **tools-by-size**
  table, a **messages-by-size** table (each row opens the [Message drill-down](message-drill-down.md)
  for that message; sortable by **#**, **Bytes**, **~Tokens**, and **Share** — default **#**
  ascending, click a column to sort and again to flip direction), and the **raw request JSON**
  (collapsed by default, capped at 2 MB).

Data comes from the `server` API — `GET /api/context` (windowed summary) and
`GET /api/context/detail?file=<base>` (one request's breakdown + raw JSON) — computed via
`summarizeContext` / `analyzeRequestBody` in `packages/core`. The detail endpoint reads
exactly one `.request.txt`; the `file` handle is validated and resolved strictly inside the
log directory, so no path traversal is possible.

## Acceptance criteria

- The Context size page shows average, median, and largest `realInput` tokens over the
  selected window, plus the request count.
- The "Largest requests" table lists the top requests peak-first; each row opens its breakdown.
- The breakdown attributes a request's size across conversation messages, tool schemas, and
  the system prompt, and exposes the raw request JSON.
- No proxy changes; the feature is read-only over existing audit sidecars and request logs.
- `packages/core` context helpers are unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Whether to add a historical chart of average/peak context per day (currently avg/median/max
  over a window only — see the design's out-of-scope note).
- Whether to group the largest requests by session id (session id is captured but not
  aggregated here).
