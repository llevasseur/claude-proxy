---
type: feature
title: Message drill-down
description: Click a row in a request's "Messages by size" or "Tools by size" table to open a subpage showing that message's or tool's entire content.
tags: [context-size, usage, dashboard]
timestamp: 2026-07-24
---

# Message drill-down

## Summary

A pair of subpages under the [Request breakdown](context-size-analytics.md) drill-down:
clicking a row in the **"Messages by size"** table opens `/context/$file/message/$index`,
and clicking one in **"Tools by size"** opens `/context/$file/tool/$index`. Each shows that
one entry in full — its role or name, byte/token size, and its complete content, rendered
either as readable blocks (**Pretty**) or as raw JSON. It answers the next question after
"which message was largest?": **what was actually in it.**

## Motivation

The [Context-size analytics](context-size-analytics.md) breakdown ranks a request's messages
by size but only shows each one's index, role, and byte count — never its content. To see
what made a message heavy you had to expand the whole request's raw JSON (capped at 2 MB) and
hunt for the right entry. This turns each row into a direct link to just that message, read
straight from the captured request body so it resolves even when the request's raw-JSON view
was truncated.

## Behavior

- **Clickable rows** — in the Request breakdown (`/context/$file`), each row of the
  "Messages by size" and "Tools by size" tables is clickable (the `#` and tool-name cells are
  also keyboard-focusable links), navigating to that entry's page.
- **Message page** (`/context/$file/message/$index`) — a **Previous / Next** pager across
  adjacent messages in the same request (disabled buttons at the first and last message), stat
  tiles for **position** (`#index` of N messages), **role**, and **size** (bytes, ~tokens),
  then a **"Full message"** card with a **Pretty / Raw** toggle. Pretty renders the message's
  content blocks — `text`, `thinking`, `tool_use` (name + input), `tool_result` (nested, flagged
  on error), and `image` (media type and approximate size, data omitted) — falling back to raw
  JSON on an unexpected shape; Raw shows the stored JSON.
- **Tool page** (`/context/$file/tool/$index`) — the same shape for one tool schema: stat tiles
  for **position** (`#index` of N tools), **name**, and **size**, then a **"Tool schema"** card
  whose Pretty view lists the tool's name, description, and a parameter table (name, type,
  description, `required` badge) drawn from its `input_schema`.
- **Breadcrumbs** — both pages carry a *Context size → Request breakdown → Message/Tool #N*
  trail back up the drill-down.

Data comes from the `server` API — `GET /api/context/message?file=<base>&index=<n>` and
`GET /api/context/tool?file=<base>&index=<n>` — which read exactly one `.request.txt` and
slice out entry `n` via `extractRequestMessage` / `extractRequestTool` in `packages/core`.
Because the server parses the full request body (only the drill-down's raw JSON is truncated),
any entry resolves regardless of request size. `file` is validated and resolved strictly inside
the log directory (no path traversal); both endpoints return 400 for an invalid `file` or
`index` and 404 when the request file or the index is absent. An omitted `index` resolves to
entry 0 rather than erroring.

## Acceptance criteria

- [x] Each "Messages by size" row links to `/context/$file/message/$index`.
- [x] The message page shows the message's role, size, and complete content.
- [x] The message content is read from the full parsed body, so it resolves even when the
      request's raw JSON was truncated.
- [x] No proxy changes; the feature is read-only over existing request logs.
- [x] `extractRequestMessage` is unit-tested; `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Whether to render text/tool-use content blocks more readably instead of raw JSON.
- Whether to add prev/next navigation between messages within a request.
