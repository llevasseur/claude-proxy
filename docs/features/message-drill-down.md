---
type: feature
title: Message drill-down
description: Click a row in a request's "Messages by size" table to open a subpage showing that message's entire content.
tags: [context-size, usage, dashboard]
timestamp: 2026-07-21
---

# Message drill-down

## Summary

A subpage of the [Request breakdown](context-size-analytics.md) drill-down: clicking a
row in the **"Messages by size"** table opens `/context/$file/message/$index`, which shows
that one conversation message in full — its role, byte/token size, and its complete content
as pretty-printed JSON. It answers the next question after "which message was largest?":
**what was actually in it.**

## Motivation

The [Context-size analytics](context-size-analytics.md) breakdown ranks a request's messages
by size but only shows each one's index, role, and byte count — never its content. To see
what made a message heavy you had to expand the whole request's raw JSON (capped at 2 MB) and
hunt for the right entry. This turns each row into a direct link to just that message, read
straight from the captured request body so it resolves even when the request's raw-JSON view
was truncated.

## Behavior

- **Messages by size → clickable rows** — in the Request breakdown (`/context/$file`), each
  row of the "Messages by size" table is clickable (the `#` cell is also a keyboard-focusable
  link), navigating to that message's page.
- **Message page** (`/context/$file/message/$index`) — stat tiles for **position** (`#index`
  of N messages), **role**, and **size** (bytes, ~tokens), followed by a **"Full message"**
  card containing the entire message object as pretty-printed JSON. A back-link returns to the
  breakdown.

Data comes from the `server` API — `GET /api/context/message?file=<base>&index=<n>` — which
reads exactly one `.request.txt` and slices out message `n` via `extractRequestMessage` in
`packages/core`. Because the server parses the full request body (only the drill-down's raw
JSON is truncated), any message resolves regardless of request size. `file` is validated and
resolved strictly inside the log directory (no path traversal); the endpoint returns 400 for a
missing/invalid `file` or `index` and 404 when the request file or index is absent.

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
