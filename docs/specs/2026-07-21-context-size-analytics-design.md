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
**Feature:** [Context-size analytics](../features/context-size-analytics.md),
[Message drill-down](../features/message-drill-down.md).
**Scope:** `claude-proxy` only — `packages/core`, `server`, `apps/admin`. No proxy capture
changes; everything needed is already recorded in the audit sidecars.

**Shipped since (2026-07-24):** built as designed, plus three additions this spec did not
plan — a **tool drill-down** (`/context/$file/tool/$index`, `/api/context/tool`,
`extractRequestTool`), a **Pretty/Raw toggle** on the message and tool pages, and
**Previous/Next pagination** on the message page plus three-level breadcrumbs in place of the
single back-links.
Two items below are **still unbuilt**: `buildContextDetail` does not return the matching
sidecar's headline numbers, so the Request breakdown page shows bytes only — no real-input
total and no timestamp. That remains the intended contract, not a cancelled one. The two
open items under *Out of scope* (per-day history, session grouping) are also still open.

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
window. Byte sizes (`request.systemBytes`, `toolsBytes`, `totalBytes`) are shown as
supporting detail on the drill-down.

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
  systemBytes, toolsBytes, totalBytes, toolCount }`. `file` is the sidecar's
  base name (`<stamp>_anthropic`) so the UI can request the drill-down. (Shipped without the
  planned `session?` field — the sidecar records a session block, but this feature ignores it.)
- `ContextSummary` — `{ requestCount, avgRealInput, medianRealInput, maxRealInput,
  max: ContextEntry | null, top: ContextEntry[], entries: ContextEntry[] }`, where `entries`
  is every request oldest-first — the full list the UI table sorts client-side.
- `summarizeContext(entries: readonly ContextEntry[], opts?: SummarizeContextOptions): ContextSummary` —
  pure math: average, median, max, the top-N largest (default 10), and the chronological list.
- `toContextEntry(sidecar: unknown, file: string): ContextEntry | null` — pure guard-and-map;
  `null` for a malformed sidecar so the server can skip it.
- `RequestBreakdown` — `{ totalBytes, systemBytes, toolsBytes, toolCount, messageCount,
  tools: BreakdownTool[], messages: BreakdownMessage[] }`, where `BreakdownTool` is
  `{index, name, bytes, estTokens}` (ranked largest-first) and `BreakdownMessage` is
  `{index, role, bytes, estTokens}` (in conversation order).
- `analyzeRequestBody(body: unknown): RequestBreakdown` — pure. Given a parsed request body,
  measures system, each tool, and each message. Byte length via `TextEncoder` (portable,
  matches the proxy's UTF-8 `Buffer.byteLength`); `estTokens ≈ round(bytes / 4)` matching the
  proxy's `estTokens`. Tolerant of malformed shapes (missing `messages`/`tools`/`system`).
- `RequestMessageDetail` — `{ index, role, bytes, estTokens, messageCount, content }`, where
  `content` is the full message object pretty-printed as JSON.
- `extractRequestMessage(body: unknown, index: number): RequestMessageDetail | null` — pure.
  Slices one conversation message out of a parsed body by position, returning its full content
  plus the same size facts `analyzeRequestBody` reports for it; `null` when there is no
  `messages` array or `index` is out of range. Backs the [Message drill-down](../features/message-drill-down.md)
  subpage.
- `RequestToolDetail` — `{ index, name, bytes, estTokens, toolCount, content }` (added after
  this spec was written), and `extractRequestTool(body, index)` — the same slice-one-item
  treatment for a **tool schema**: position in the original `tools` array (not its size rank),
  its name (`(unnamed)` when absent), size facts, and the full schema pretty-printed. `null`
  for a missing `tools` array or an out-of-range index.

Exported from `packages/core/src/index.ts`. Tested in `packages/core/test/context.test.ts`
following the `makeSidecar` helper convention.

### Server (`server/`)

- `logs.ts` — new `includeFile` read option that attaches `__file` (the base name, i.e. the
  audit filename minus `.audit.json`) to each parsed sidecar, mirroring the existing
  `includeSkimRequests`/`skimRequestText` pattern. Also a small `readRequestBody(logDir,
  file, maxRawBytes = 2_000_000)` helper that validates `file` against
  `^[0-9A-Za-z:_.\-]+_anthropic$` (no `/`, no `..`), re-checks the resolved path's directory,
  reads `<file>.request.txt` strictly inside `logDir`, JSON-parses it, and returns the parsed
  body alongside the pretty-printed raw text and a `truncated` flag — so the 2 MB cap lives
  here rather than in each caller.
- `api.ts`:
  - `buildContext(logDir, days)` — reads sidecars over the window with `includeFile`, maps
    valid ones to `ContextEntry[]`, returns `summarizeContext(...)` plus `meta`.
  - `buildContextDetail(logDir, file)` — reads that one request body, returns
    `{ file, evicted: false, breakdown: analyzeRequestBody(body), raw, truncated }`. Since the
    [retention lifecycle](../features/retention-lifecycle.md) shipped, a body that was archived
    and then evicted returns the `{ file, evicted: true, day, retentionDays, retained }` branch
    with a 200 rather than a 404; only a genuinely absent file is a 404. (Still shipped
    **without** the planned sidecar headline numbers — see *Shipped since* above.)
  - `buildContextMessage(logDir, file, index)` — reads that one request body and returns
    `extractRequestMessage(body, index)`. Uses the full parsed body (not the truncated raw
    JSON), so any message resolves regardless of request size. Backs the message drill-down.
  - `buildContextTool(logDir, file, index)` — the same for one tool schema via
    `extractRequestTool`; throws `tool index out of range` when the position is absent.
- `server.ts` — routes `/api/context` (`?days=`), `/api/context/detail` (`?file=`),
  `/api/context/message` and `/api/context/tool` (both `?file=` + `?index=`). `days` goes
  through `parseDays`: non-numeric falls back to 14, otherwise floored and clamped to 1–365.
  The drill-downs return 400 on a missing/invalid `file` or `index`, 404 when the request file
  or the index is absent.

### UI (`apps/admin/`)

- `api.ts` — `getContext(days)`, `getContextDetail(file)`, `getContextMessage(file, index)`,
  and `getContextTool(file, index)` with response interfaces mirroring the server envelopes;
  `ContextSummary`/`RequestBreakdown` imported as types from core.
- New nav station **"Context size"** (`hint: "prompt"`) in `router.tsx`, route `/context`.
- `routes/context.tsx` — window selector (7/14/30, like Trends), StatCards (Average / Median /
  Largest context, Requests), and a **"Requests"** table (when, model, real input, system,
  tools, size) listing every request in the window, sortable per column and client-side, where
  each row links to the drill-down. The peak row is marked ` · peak`.
- `routes/context-detail.tsx` — route `/context/$file`. A **"Why it was this large"** region
  table (system / tools / messages as shares of the request), a sortable **"Messages by size"**
  table (index, role, bytes, ~tokens, share) whose rows link to the message drill-down, a
  **"Tools by size"** table whose rows link to the tool page, and a collapsible **"Raw request
  JSON"** block (with a note if truncated). Breadcrumbs back to `/context`. The planned
  real-input/timestamp header is not built — the API doesn't return those numbers yet.
- `routes/context-message.tsx` — route `/context/$file/message/$index` via `getContextMessage`.
  Stat tiles (position `#index` of N, role, bytes/~tokens), a "Full message" card with a
  **Pretty / Raw** toggle (rendered blocks vs. pretty-printed JSON), and Previous/Next
  navigation between adjacent messages in the same request. See the
  [Message drill-down](../features/message-drill-down.md) feature.
- `routes/context-tool.tsx` — route `/context/$file/tool/$index` via `getContextTool` (added
  after this spec was written). Stat tiles (position `#index` of N tools, name, bytes/~tokens)
  and a "Tool schema" card with the same **Pretty / Raw** toggle — Pretty renders the name,
  description, and a parameter table from `input_schema` with `required` badges. No
  Previous/Next here; that pagination exists only on the message page.
- `components/Breadcrumbs.tsx` — the shared trail all three drill-down pages use
  (`Context size › Request breakdown › Message/Tool`), replacing the single back-links this
  spec originally called for.

## Data-volume / performance

`/api/context` reads only `.audit.json` sidecars over the selected window — the same cost as
the existing Tools/Trends endpoints. The three drill-down endpoints (`/api/context/detail`,
`/api/context/message`, `/api/context/tool`) each read exactly **one** `.request.txt` (the
selected request), never the whole corpus. Raw JSON is capped at 2 MB before it crosses the
wire; the message and tool endpoints slice the *parsed* body, so they resolve even past that cap.

## Security / safety

- The proxy stays a passive observer — unchanged. This feature is read-only over existing logs.
- `file` is strictly validated and resolved inside `logDir`; path traversal is rejected.
- Sidecars/request bodies already have auth headers redacted upstream; the raw JSON shown is
  the request body (messages/system/tools), which carries no credentials.

## Testing

- Core: `context.test.ts` — empty input; average/median/max over several entries; the even-count
  median; top-N ordering and cap; `entries` returned oldest-first regardless of input order;
  `toContextEntry` for a valid and a malformed sidecar; `analyzeRequestBody` for a normal body,
  a string-content message, and a malformed/empty body; `extractRequestMessage` and
  `extractRequestTool` each for a valid index, an out-of-range/non-integer index, and a
  malformed body — plus that a tool's `index` is its original array position, not its size rank.
- Typecheck + existing test suite must stay green (`pnpm typecheck`, `pnpm test`).

## Out of scope (YAGNI)

- No proxy schema changes (no persisted message count — derived on demand in the drill-down).
- No per-session grouping page — and as shipped this feature drops session identity entirely
  (`ContextEntry` has no `session`), so nothing here shows a session id. Sessions are browsed
  through [Session transcripts](../features/session-transcripts.md) instead.
- No historical percentile charts beyond avg/median/max.
