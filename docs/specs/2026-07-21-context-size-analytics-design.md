---
type: design
title: Context-Size Analytics — Design Spec
description: Surface how large the prompt/context sent to the model gets — average, largest, and why the largest was so large.
tags: [context-size, usage, dashboard, design]
timestamp: 2026-07-21
---

# Context-Size Analytics — Design Spec

**Date:** 2026-07-21
**Status:** Approved (key decisions confirmed; PR is the review gate)
**Builds on:** [`2026-07-15-monorepo-admin-dashboard-design.md`](2026-07-15-monorepo-admin-dashboard-design.md)
and the [Admin dashboard for claude-proxy usage](../features/admin-dashboard-for-claude-proxy-usage.md) feature.
**Feature:** [Context-size analytics](../features/context-size-analytics.md).
**Scope:** `claude-proxy` only — `packages/core`, `server`, `apps/admin`. No proxy capture
changes; everything needed is already recorded in the audit sidecars.

## Goal

Show the user how large their context (prompt) gets over time:

1. **Average context size** — the typical prompt size sent to the model.
2. **Largest context** — when it peaked and how big it was.
3. **Why the largest was so large** — a raw-data drill-down for the peak request (or any
   request in the top list): system-prompt size, tool schemas (per-tool), the conversation
   messages, and the full captured request JSON.

## Metric

"Context size" = **`tokens.realInput`** from each audit sidecar
(`input + cacheRead + cacheCreation`), already documented in `packages/core/src/types.ts` as
"the true prompt size sent to the model." This is the number that fills the model's context
window, so it maps directly to the user's question. Byte sizes (`request.systemBytes`,
`toolsBytes`, `totalBytes`) are shown as supporting detail on the drill-down.

## Architecture

Reuses the existing pipeline end to end — no new storage, no proxy changes:

```
proxy (already captures) → logs/*.audit.json + *.request.txt
  → server/src/logs.ts (readSidecars)
  → packages/core (pure aggregation, this feature adds context.ts)
  → server/src/api.ts (build* → /api/*)
  → apps/admin (React page)
```

### Core (`packages/core/src/context.ts`) — pure, tested

- `ContextEntry` — one request's context facts: `{ file, timestamp, model, realInput,
  systemBytes, toolsBytes, totalBytes, toolCount, session? }`. `file` is the sidecar's
  base name (`<stamp>_anthropic`) so the UI can request the drill-down.
- `ContextSummary` — `{ requestCount, avgRealInput, medianRealInput, maxRealInput,
  max: ContextEntry | null, top: ContextEntry[] }`.
- `summarizeContext(entries: ContextEntry[], opts?: { topN?: number }): ContextSummary` —
  pure math: average, median, max, and the top-N largest (default 10).
- `RequestBreakdown` — `{ totalBytes, systemBytes, toolsBytes, tools: {name, bytes,
  estTokens}[], messages: {index, role, bytes, estTokens}[], messageCount }`.
- `analyzeRequestBody(body: unknown): RequestBreakdown` — pure. Given a parsed request body,
  measures system, each tool, and each message. Byte length via `TextEncoder` (portable,
  matches the proxy's UTF-8 `Buffer.byteLength`); `estTokens ≈ round(bytes / 4)` matching the
  proxy's `estTokens`. Tolerant of malformed shapes (missing `messages`/`tools`/`system`).

Exported from `packages/core/src/index.ts`. Tested in `packages/core/test/context.test.ts`
following the `makeSidecar` helper convention.

### Server (`server/`)

- `logs.ts` — new `includeFile` read option that attaches `__file` (the base name, i.e. the
  audit filename minus `.audit.json`) to each parsed sidecar, mirroring the existing
  `includeSkimRequests`/`skimRequestText` pattern. Also a small `readRequestBody(logDir,
  file)` helper that validates `file` against `^[0-9A-Za-z:_.\-]+_anthropic$` (no `/`, no
  `..`), reads `<file>.request.txt` strictly inside `logDir`, and JSON-parses it.
- `api.ts`:
  - `buildContext(logDir, days)` — reads sidecars over the window with `includeFile`, maps
    valid ones to `ContextEntry[]`, returns `summarizeContext(...)` plus `meta`.
  - `buildContextDetail(logDir, file)` — reads that one request body, returns
    `analyzeRequestBody(body)` plus the raw JSON text (pretty-printed, capped at a sane size
    with a `truncated` flag) and the matching sidecar's headline numbers.
- `server.ts` — routes `/api/context` (`?days=`) and `/api/context/detail` (`?file=`).
  Detail returns 400 on a missing/invalid `file`, 404 when the request file is absent.

### UI (`apps/admin/`)

- `api.ts` — `getContext(days)` + `getContextDetail(file)` with response interfaces mirroring
  the server envelopes; `ContextSummary`/`RequestBreakdown` imported as types from core.
- New nav station **"Context"** (`hint: "size"`) in `router.tsx`, route `/context`.
- `routes/context.tsx` — window selector (7/14/30, like Trends), StatCards (Avg / Median /
  Max context tokens, Requests), and a "Largest requests" table (time, model, real input,
  system B, tools B) where each row links to the drill-down. The peak row is marked.
- `routes/context-detail.tsx` — route `/context/$file`. Header with the request's real-input
  total and timestamp; a breakdown card (system / tools / messages as shares of the request);
  a per-tool table; a per-message table (index, role, bytes, ~tokens); and a collapsible/raw
  `<pre>` block with the full request JSON (with a note if truncated). A back-link to
  `/context`.

## Data-volume / performance

`/api/context` reads only `.audit.json` sidecars over the selected window — the same cost as
the existing Tools/Trends endpoints. `/api/context/detail` reads exactly **one**
`.request.txt` (the selected request), never the whole corpus. Raw JSON is capped before it
crosses the wire.

## Security / safety

- The proxy stays a passive observer — unchanged. This feature is read-only over existing logs.
- `file` is strictly validated and resolved inside `logDir`; path traversal is rejected.
- Sidecars/request bodies already have auth headers redacted upstream; the raw JSON shown is
  the request body (messages/system/tools), which carries no credentials.

## Testing

- Core: `context.test.ts` — empty input; average/median/max over several entries; top-N
  ordering and cap; `analyzeRequestBody` for a normal body, a string-content message, and a
  malformed/empty body.
- Typecheck + existing test suite must stay green (`pnpm typecheck`, `pnpm test`).

## Out of scope (YAGNI)

- No proxy schema changes (no persisted message count — derived on demand in the drill-down).
- No per-session grouping page (session id is shown, not aggregated).
- No historical percentile charts beyond avg/median/max.
