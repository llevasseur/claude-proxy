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
  **"Threads"** table showing **one row per thread**, not per request. `groupContextThreads`
  in `packages/core` gathers a thread's requests wherever they landed in the window — they
  interleave with other threads' — and the row stands in for all of them: its **Model**,
  **Peak input**, **System**, **Tools**, and **Size** cells are the thread's *largest*
  request (ties keep the earlier one), **Started** is when the thread's first captured
  request arrived with an arrow to its last, and the first cell carries the opening prompt,
  the short thread id, and the request count. A request whose sidecar recorded no thread id
  is its own one-request row and links straight to its breakdown. Default order is
  **Started** newest-first; sortable by **Started**, **Model**, **Peak input**, **System**,
  **Tools**, and **Size** (click a column to sort and again to flip direction) — every
  comparison reads the group, so the order is never decided by a request the row does not
  show. The window's overall peak is tagged in place. A **search box** over the table narrows
  it by what was *asked for*: every row carries the opening prompt of the thread it
  represents, reduced to the text a person typed — no system prompt, no `<system-reminder>`
  block (which is where `AGENTS.md`, `CLAUDE.md`, and memory get injected), and for a slash
  command the arguments only, never the inlined command definition. Matching is
  case-insensitive and every whitespace-separated term must appear; `"a phrase"` in double
  quotes matches whole. A matching row shows an excerpt of that prompt windowed on the first
  term. **Grouping, searching, ordering and slicing all happen on the server**, over the whole
  window: the route takes `sort`, `dir`, `offset`, `limit` and `q` and answers with one page of
  thread rows (100 by default, 500 at most), so clicking a column or typing in the search box
  asks for that order's first page rather than re-sorting a month of requests in the browser —
  a 30-day window was 40862 rows and 29.6 MB of JSON. Paging is Previous/Next below the table,
  and a new order, a new search or a new window is a new first page. A thread that recorded no
  opening prompt is never a match — the caption says how many prompts are searchable, and how
  many of the window's threads the search matched.
- **The window is read as its reporting days, and a closed day is read once.** A reporting day
  that has ended can no longer gain a request, so `buildContext` reduces each day to a
  `ContextDayAggregate` — the request count, the `realInput` sum, that day's `realInput` values
  sorted, its peak and largest requests, and its slice of the thread index — and keeps the closed
  ones in two levels: a map for the process, over a `context_day` row that outlives it. A window
  is the sum of the days it covers. Only the day in progress, and any day the live directory
  still holds part of, is reduced again per request. This is what makes the sort click, the page
  click and the search keystroke above cheap: each of them re-asks the route, and each used to
  re-read every sidecar in the span. The sum is exact rather than approximate — the mean comes
  from summed totals rather than a mean of means, and the median from the days' sorted values
  concatenated, since a median has no per-day summary it can be recovered from. Ties in `top`,
  in the peak and in a thread's row are broken by the earlier request exactly as before, because
  days are merged oldest-first under the same strictly-greater rule the single pass used. The
  rows are **derived and disposable**, like `day_digest` and `usage_day` beside them: `logs/`
  stays the source of truth and `rm logs/claude-proxy.db && pnpm --filter @agent-proxy/claude-server ingest` rebuilds
  everything. See [ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md).
- **Thread page** (`/context/thread/$threadId?days=<n>`) — the shared drill-down a thread's
  single row opens: its opening prompt and full thread id, stat tiles for **requests**,
  **peak** and **average** context and the **span**, then a **"Requests"** table of every
  captured request the thread sent, oldest first, each row opening that request's own
  breakdown. It carries the window it was reached from in `?days=`, so the page holds the
  same 7/14/30 days the table did, and an empty window answers an empty list rather than a
  404. Rows link on to `/context/$file?thread=…&days=…`, which is what lets the breakdown
  show a **Thread** breadcrumb back to this page — a captured request body records no ids of
  its own.
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

Data comes from the `server` API — `GET /api/context?days=<n>&sort=<col>&dir=<asc|desc>&offset=<n>&limit=<n>&q=<text>`
(windowed aggregates plus one page of thread rows; `days` is
clamped to 1–365, default 14, or `all` — the `0` the picker sends — for every day on record,
whose floor is the oldest day the corpus holds rather than a clamp. `sort` is one of `when`,
`model`, `realInput`, `systemBytes`, `toolsBytes`, `size`, and an unreadable or out-of-range
paging parameter falls back to the default page rather than erroring. The response's `summary`
is an `aggregateContext` over the **whole** window — average, median, largest and the `top`
ten never describe the page — while `page` carries the ordered slice, `total`, `matched` and
`searchable`),
`GET /api/context/thread?thread=<id>&days=<n>` (one thread's
requests, oldest first, plus its opening prompt), `GET /api/context/detail?file=<base>` (one
request's breakdown + raw JSON), and `GET /api/context/tool?file=<base>&index=<n>` (one tool
schema) — computed via `aggregateContext` + `groupContextThreads` / `analyzeRequestBody` /
`extractRequestTool` in `packages/core`.

`buildContextThread` selects on **thread id alone** rather than reusing the session-id
fallback that widens a session view, because that fallback would hand a subagent's page every
request its parent sent. It goes through the same `SidecarSource` seam as the windowed
summary, so it is shadow-checked alongside it.

The **windowed summary** goes through the `SidecarSource` seam
([ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)): by default the SQLite
substrate answers `readSidecars` from its tables with no directory read at all, `DB_READS=0`
puts `buildContext` back on the original `logs/*.audit.json` scan, and `SHADOW_DB=1` re-runs
the build against the other backing to compare. That read asks for the window with
**`omitTools`**, a `ReadOptions` flag saying the caller reads `request.toolCount` and never
the per-tool list: the substrate then skips the `request_tool` join outright, and every
sidecar comes back with an empty — not a missing — `tools` array, since `isAuditSidecar`
requires one. The file backing empties it too, so the two backings keep handing the builder
the same object and the byte-for-byte parity comparison is unaffected. The **prompt text is fetched through that
same seam** by a bounded `readRootPrompts(logDir, threadIds)` — it names only the threads the
window actually contains, reading `logs/sessions/<threadId>.state.json`'s untruncated `root`
on the file backing and the `session.root_prompt` column on the SQLite one, then
`attachContextPrompts` runs each through `userPromptText` in `packages/core`. The lookup keys
on **thread id, never session id**: a session id spans an agent and its subagents, so keying
on it would label a subagent's request with its parent's prompt. The **drill-downs are outside the seam** —
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
- The "Threads" table lists one row per thread in the window — never one per request —
  showing that thread's largest request, ordered by start time by default and sortable by
  started, model, peak input, system, tools, and size; each row opens the thread's own page,
  and a request with no thread id opens its breakdown directly.
- The thread page lists every request the thread sent in the window with its prompt, span,
  count and peak, and each of its rows opens that request's breakdown with a breadcrumb back.
- Each row carries its thread's opening prompt reduced to human-authored text, and the search
  box narrows the table to the rows whose prompt contains every query term; a thread that
  recorded no prompt never matches.
- `/api/context` answers with one page of thread rows rather than every request in the window,
  ordered and searched server-side, and its summary tiles stay computed over the whole window
  whichever page is asked for.
- Every table stays inside its card at any viewport width, scrolling horizontally below its
  columns' combined minimum rather than overflowing.
- The breakdown attributes a request's size across conversation messages, tool schemas, and
  the system prompt, and exposes the raw request JSON.
- Each "Tools by size" row opens `/context/$file/tool/$index`, showing that tool's full schema
  (Pretty parameter table or Raw JSON), read from the parsed request body so it resolves even
  when the raw JSON was truncated.
- No proxy changes; the feature is read-only over existing audit sidecars and request logs.
- `packages/core` context helpers are unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- ~~**The window selector cannot see an archived day.**~~ **Resolved.** `buildContext` now calls
  `readWindow` in `server/src/db/source.ts`, which composes `logs/archive/<date>/` with the live
  root, so an archived day stays in the tiles and the "Requests" table rather than the 30-day
  window collapsing to roughly today on a maintained install.
- Whether to add a historical chart of average/peak context per day. Still open as a *view* —
  the page shows avg/median/max over a window and nothing per day. But the data it would need
  now exists: `buildContext` reads its window one reporting day at a time and keeps each closed
  day's aggregate in `context_day` (count, `realInput` sum, the day's sorted token counts, its
  peak, its largest requests, and its slice of the thread index). A chart would read those rows
  rather than re-derive them, so what is left is the chart, not the history behind it.
- ~~Whether to group the largest requests by session id (session id is captured but not
  aggregated here).~~ **Resolved as thread id, not session id.** The table groups by
  `threadId`, which names exactly one transcript; a session id spans an agent together with
  its subagents, so grouping on it would fold a subagent's requests into its parent's row.
  Whether to offer a *second*, coarser view that rolls a whole agent family up by session id
  is still open.
