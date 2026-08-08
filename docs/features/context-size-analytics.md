---
type: feature
title: Context-size analytics
description: A dashboard page showing how large the prompt sent to the model gets — average, largest, and why the largest was so large.
tags: [context-size, usage, dashboard]
timestamp: 2026-08-02
---

# Context-size analytics

## Summary

A "Context size" page in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md)
answering **what the average context size is, when it was largest, and why the largest was
so large** — the "why" being a raw-data drill-down for any of the largest requests. Designed in
[`2026-07-21-context-size-analytics-design.md`](../specs/2026-07-21-context-size-analytics-design.md).

## Motivation

The proxy already records, per request, the true prompt size that fills the model's
context window (`tokens.realInput` = input + cache-read + cache-creation) plus the byte
sizes of the system prompt, each tool schema, and the full request body. This surfaces
*how big context gets over time* and *what made a given request so large* from that
captured data, without touching the passive-observer proxy.

## Behavior

- **Metric** — context size is `realInput` tokens, the true prompt size sent to the model.
- **Context size page** (`/context`) — a 7/14/30-day window selector, stat tiles for
  **average / median / largest** context (tokens per request) and the request count, and a
  **"Requests"** table listing every request in the window where each row links to its
  breakdown. Default order is **When** newest-first; sortable by **When**, **Model**,
  **Real input**, **System**, **Tools**, and **Size** (click a column to sort and again to
  flip direction). The peak request is tagged in place. The window is **live-day-only**:
  `buildContext` reads the live log directory and has no archive fallback — see the open
  question below.
- **Request breakdown** (`/context/$file`) — the "why so large" drill-down for one captured
  request: totals (request bytes, message count, tool count, system-prompt bytes), a
  **region table** (conversation messages vs. tool schemas vs. system prompt as shares of the
  request), a **messages-by-size** table (each row opens the
  [Message drill-down](message-drill-down.md) for that message; the **#** column numbers
  messages from 1 while the route stays 0-based; sortable by **#**, **Bytes**, **~Tokens**,
  and **Share** — default **#** ascending, click a column to sort and again to flip
  direction), a **tools-by-size** table (each row opens that tool's schema page), and the
  **raw request JSON** (collapsed by default, capped at 2 MB). Breadcrumbs link back up to the
  Context size page, and coming back from a drill-down restores the scroll position the page
  was left at.
- **Tool schema page** (`/context/$file/tool/$index`) — one tool schema in full: stat tiles
  for **position** (`#index` of N tools), **name**, and **size** (bytes, ~tokens), then a
  **"Tool schema"** card with a **Pretty** view (name, description, and a required-flagged
  parameter table drawn from `input_schema`) and a **Raw** JSON view.

Data comes from the `server` API — `GET /api/context?days=<n>` (windowed summary; `days` is
clamped to 1–365, default 14), `GET /api/context/detail?file=<base>` (one request's breakdown
+ raw JSON), and `GET /api/context/tool?file=<base>&index=<n>` (one tool schema) — computed via
`summarizeContext` / `analyzeRequestBody` / `extractRequestTool` in `packages/core`.

The **windowed summary** goes through the `SidecarSource` seam
([ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)): by default the SQLite
substrate answers `readSidecars` from its tables with no directory read at all, `DB_READS=0`
puts `buildContext` back on the original `logs/*.audit.json` scan, and `SHADOW_DB=1` re-runs
the build against the other backing to compare. The **drill-downs are outside the seam** —
`buildContextDetail`, `buildContextMessage`, and `buildContextTool` take no `source` and still
read exactly one `.request.txt` from disk, because a captured body is verbatim text the
substrate does not hold.

Those drill-downs look in the live log directory first and then in `logs/archive/<day>/` for
the day the filename carries, so an archived request still resolves. When the sidecar is there
but the body is gone, the answer is a **200 carrying `evicted: true`** — with the archived
`day`, the `retentionDays` window, and the retained sidecar — not a 404; only a request with
neither file left is a 404. Body eviction is a normal terminal state for the breakdown, the
message drill-down, and the tool schema page: metrics survive it, verbatim text does not. The
`file` handle is validated and resolved strictly inside the log directory (or that one archive
day), so no path traversal is possible.

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

- ~~**The window selector cannot see an archived day.**~~ Resolved. `buildContext` calls
  `readWindow` in `server/src/db/source.ts`, the one reader that composes the live directory
  with `logs/archive/<date>/`, so an archived day's requests stay in the tiles and the
  "Requests" table rather than only in the drill-downs those rows link to.
- Whether to add a historical chart of average/peak context per day (currently avg/median/max
  over a window only — see the design's out-of-scope note).
- Whether to group the largest requests by session id (session id is captured but not
  aggregated here).
