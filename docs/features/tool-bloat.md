---
type: feature
title: Tool bloat
description: A dashboard page ranking every tool schema in a day's request payloads by the bytes and estimated tokens it costs, and its share of all tool bytes.
tags: [dashboard, usage, context-size]
timestamp: 2026-08-02
---

# Tool bloat

## Summary

The **Tool bloat** page (`/tools`) ranks every tool whose schema appeared in a day's
captured request payloads by the bytes it contributed, its estimated tokens, and its share
of all tool bytes.

## Motivation

Tool schemas are re-sent on every request and cost input tokens each turn regardless of
whether the tool is used. [Context-size analytics](context-size-analytics.md) shows *that* a
request was large; this page shows *which tool definitions* made it large — actionable by
trimming an MCP server or narrowing an allow-list.

## Behavior

- **One day at a time, in the live directory** — `GET /api/tools?date=YYYY-MM-DD`,
  defaulting to today. The date is parsed by the server's shared `parseDate`, and the
  response carries the `date` it actually used alongside `meta.files` and
  `meta.parseErrors`. The page never sends a date, so it is always today. Unlike
  `/api/trends`, `buildTools` reads only the live day set — a day `maintain` has moved
  into `logs/archive/<date>/` answers with an empty table.
- **Aggregation** (`packages/core/src/digest.ts`) — `computeDigest` sums each tool's
  `bytes` and `estTokens` across every valid sidecar for the day, keyed by tool name, then
  ranks by `totalBytes` descending. `pctOfToolBytes` is that tool's share of *all* tool
  bytes for the day, not of the whole request. `buildTools` asks for `topN: 200`, above the
  digest's own default of 12, so the page lists every tool seen.
- **The table** — columns **Tool**, **Bytes**, **~Tokens**, **% of tools**, and a
  **Share** bar scaled against the largest tool's `totalBytes`.
- **Unaffected by body eviction** — every number comes from the `.audit.json` sidecar,
  which [retention](retention-lifecycle.md) keeps forever. Evicting a day's `.md` and
  `.request.txt` bodies at 30 days leaves this table byte-identical.
- **Empty states** — *"No tool data for this day."* when the day has no tools; the page
  header carries the resolved date and the note *"ranked by bytes per request payload"*.

Data path: audit sidecar tool list → the `SidecarSource` seam
(`server/src/db/source.ts`) → `computeDigest` (`topTools`) → `buildTools`
(`/api/tools`) → the **Tool bloat** page. Read-only over already-captured sidecars.
`buildTools` runs behind the seam ([ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)): by
default the SQLite substrate answers `readSidecars` from its tables with no directory
read, `DB_READS=0` puts the route back on the original `logs/*.audit.json` scan, and
`SHADOW_DB=1` re-runs the build against the other backing to compare. Either way the day
set is the live directory's — the "one day at a time, in the live directory" limit above
is a property of the query, not of the file scan.

## Acceptance criteria

- [x] `/tools` ranks tools by total bytes descending, for a single day.
- [x] Each row reports bytes, estimated tokens, and share of all tool bytes for that day.
- [x] The share bar is scaled against the largest tool, not against 100%.
- [x] `GET /api/tools` defaults to today and echoes the date it resolved.
- [x] A day with no captured tool data renders an empty state rather than an error.

## Open questions

- **The page is a single day with no trend.** Whether a tool's schema grew over time — the
  question that catches a regressing MCP server — needs a multi-day view this page lacks.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Context-size analytics](context-size-analytics.md)
