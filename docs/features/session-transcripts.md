---
type: feature
title: Session transcripts
description: The proxy reconstructs a per-thread conversation transcript from the requests it already observes, and the dashboard browses them live.
tags: [dashboard, usage, backend]
timestamp: 2026-07-24
---

# Session transcripts

## Summary

Every Claude Code request carries the full running `messages[]`, so the proxy can keep a
durable, append-only record of what each agent did with no agent-side hook: one distilled
Markdown transcript per conversation thread under `logs/sessions/`. The
[admin dashboard](admin-dashboard-for-claude-proxy-usage.md) lists those transcripts, reads
one in full, and drills into its errored tool results — all streamed live over SSE, so a
transcript grows on screen while the agent is still working.

## Motivation

The audit sidecars are per-*request*: one `.audit.json` per `/v1/messages` call, excellent
for token/cost/context math and useless for "what did that agent actually do?" — a
conversation is a thread of many requests. Session-level attribution was explicitly listed
**out of scope** in [`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md)
("**Sessions** are intentionally omitted — the logs carry no reliable session ID", and again
under Out of scope: "Session-level attribution (no session ID in logs)"). Two observations
made it possible after all. First, Claude Code *does* send `x-claude-code-session-id` on every
request — `extractSession` in `proxy/proxy.mjs` reads it (alongside the `account_uuid` /
`session_id` / `device_id` ids inside the `metadata.user_id` blob). Second, that header alone
is not enough, because one session id covers the main agent, its subagents, and one-shot
helpers; but since each request replays the whole conversation, `proxy/session.mjs` can key a
thread by *(session id + a fingerprint of its first user message)* and separate them. The
"no reliable session ID" blocker was really a granularity problem, and the wire already
carried the fix.

## Behavior

- **Thread identity** — `threadIdFor` hashes `sessionId` + the thread's first real user text
  (SHA-256, first 16 hex chars). Transcripts are written to `<LOG_DIR>/sessions/<threadId>.md`,
  with a `<threadId>.state.json` progress sidecar so a proxy restart resumes instead of
  re-appending. Growth is the filter for noise: a thread's first sighting is buffered in memory
  and only flushed once it reappears larger, so a one-shot helper seen exactly once never
  reaches disk.
- **What a line records** — the header is written once (`# Session <threadId>`, then
  `- model:`, `- session:`, `- started:`, optionally `- title:` and `- subtitle:`), and each
  subsequent request appends only its new turns (`messages.slice(lastSeenCount)`), distilled to
  `## Task:` headings, `- decided:` (assistant text before a tool call), tool lines like
  `- Bash(command=…)` (name plus at most one allowlisted identifying arg, truncated),
  `- ✗ …` for an errored tool result, and `- done:` for an outcome. Never the system prompt,
  tool schemas, tool-result payloads, or full prose.
- **Title and subtitle** — the **subtitle** is the thread's opening prompt with its injected
  `<system-reminder>` blocks stripped and whitespace collapsed, known at first sighting. The
  **title** is the CLI's own generated chat title, which arrives out of band: the CLI asks for
  it in a *separate* `/v1/messages` request under a *different* session id, so
  `isTitleRequest` recognizes it by its system prompt, `extractTitle` pulls the `{"title": …}`
  reply, and it is linked back by content (the titling request's `<session>…</session>` payload
  opens with the thread's reminder-free root prompt). A title that arrives *before* its thread
  is confirmed is held and rides into the header; a title that arrives *after* the header was
  flushed is appended as a standalone `- title:` line — which is why the parser in
  `packages/core/src/sessions.ts` does not confine `- title:` to the header block. A user
  *renaming* a chat is local to the CLI and never hits the wire, so only generated titles are
  observable.
- **Sessions list** (`/sessions`) — **"Append-only agent transcripts the proxy captured"**, the
  resolved `sessions/` path, and a card headed **"N sessions"** ("click a column to sort · click
  a row to read the transcript"). Columns: **Session** (the generated title over the linked
  thread id, with the subtitle — or first task — as a preview line), **Model**, **Tasks**,
  **Tools**, **Errors**, **Updated**. Default order is **Updated** newest-first; every column
  sorts, and clicking again flips direction. A non-zero **Errors** count links straight to that
  session's errors page. Empty state: **"No session transcripts yet."**
- **Session detail** (`/sessions/$id`) — title and subtitle as a heading, then stat tiles for
  **Model**, **Started**, **Tasks**, **Tools**, **Decisions**, **Errors** (the Errors tile
  is itself a link — **"view details →"** — when non-zero), and **Peak context**, the underlying
  session id and file size, and a **"Transcript"** card with a **Pretty** / **Raw** toggle
  (rendered Markdown vs. the raw file).
- **Peak context → Request breakdown** — the **Peak context** tile links into the Context
  section's [request breakdown](context-size-analytics.md) (`/context/$file`) for this session's
  largest captured request, showing its real input tokens over **"request breakdown →"** and how
  many requests the session sent. `GET /api/sessions/breakdown?id=<threadId>` reads the
  transcript's session id, scans `.audit.json` sidecars from the session's start date onward
  (a session's requests never predate it), and returns the largest match. Requests are attributed
  by the sidecar's `session.sessionId`, which the proxy reads off the `x-claude-code-session-id`
  header — that id spans the whole agent family, so the peak may belong to a subagent of the
  thread being viewed. The tile reads a muted **—** with the reason underneath: **"loading…"**
  while the lookup runs, **"no session id"** on a transcript that carries none (which skips the
  request entirely), **"lookup failed"** when the call errors, and **"no captured requests"**
  when nothing matched — including legacy sidecars written before `session` was captured.
- **Session errors** (`/sessions/$id/errors`) — **"Errored tool results captured in this
  session"**: one **"Error #n"** entry per `- ✗` line, each tagged with the **Task** it fell
  under and the **Tool** most likely responsible (the nearest preceding tool-call line, or
  *unknown*). The proxy records only a one-line gist per error, disconnected from the call that
  produced it (that call is in a prior turn), so `parseSessionErrors` re-links them, blaming
  each call at most once. Each entry carries a stable `error-<index>` anchor for deep links.
  Empty state: **"No errors recorded in this session."**
- **Live streaming over SSE** — `GET /api/sessions/stream` watches the `sessions/` directory and
  re-lists with a **400 ms** debounce; `GET /api/sessions/session/stream?id=<threadId>` watches
  that one transcript file with a **150 ms** debounce. Both send the current value as a
  `snapshot` event, then an `update` event (same shape) per change, skipping byte-identical
  payloads from spurious fs events. A comment-frame heartbeat every **25 s** keeps the
  connection from idling out, and the initial build runs *before* the SSE headers so a bad id or
  missing file surfaces as a normal 400/404/500 that `EventSource` reports without reconnecting.
  `useLiveQuery` mirrors each frame into the React Query cache under the page's existing query
  key, so the paired one-shot query stays the fallback; its status is `connecting`, `live`, or
  `offline`, shown by **LiveIndicator** as **Live** / **Connecting…** / **Offline** with a
  pulsing teal, amber, or coral dot.

The data path is `proxy/session.mjs` (best-effort append on every observed request) →
`logs/sessions/<threadId>.md` → `packages/core/src/sessions.ts` (`parseSessionTranscript`,
`parseSessionErrors`) → `server` (`listSessions` / `readSession` behind `GET /api/sessions`,
`/api/sessions/session`, `/api/sessions/errors` and the two SSE routes) → `apps/admin`. Thread
ids come from the URL, so `resolveSessionFile` requires a 16-hex-char stem and confirms the
resolved path stays inside `sessions/` — no traversal, 400 for a bad id and 404 for a missing
transcript.

## Acceptance criteria

- [x] The proxy writes one append-only transcript per conversation thread to
      `logs/sessions/<threadId>.md`, keyed by session id + conversation root.
- [x] Transcript capture is a pure side effect of the passive proxy: it runs after the reply is
      already streamed back to the client (and on a skim cache hit too), adds no upstream call,
      and never throws into the request path.
- [x] A thread seen only once is buffered and never written; a `.state.json` sidecar makes
      restarts resume rather than duplicate.
- [x] Each transcript records the model, session id, start time, generated title and subtitle,
      and a distilled line per task, decision, tool call, errored result, and outcome — never
      system prompts, tool schemas, or tool-result payloads.
- [x] A title captured after the header was flushed is appended as its own `- title:` line and
      still parses.
- [x] `/sessions` lists every transcript with tasks/tools/errors counts, sortable columns, and
      newest-updated first; `/sessions/$id` shows the stat tiles plus the transcript in pretty
      or raw form; `/sessions/$id/errors` lists every errored tool result with its task and
      likely tool.
- [x] The sessions list and one session both update live over SSE (400 ms / 150 ms debounce,
      25 s heartbeat), with the connection state shown on screen and the one-shot query as
      fallback.
- [x] A session's detail page links to the Request breakdown of its largest captured request,
      and degrades to a muted tile when no sidecar carries the session's id.
- [x] Session-id and thread-id handling is validated server-side against path traversal.
- [x] The session parsers (`parseSessionTranscript`, `parseSessionErrors`) are unit-tested in
      `packages/core/test/sessions.test.ts`.

## Open questions

- The sidecar's `session` block is now typed as `AuditSession` and consumed — `sessionId` joins
  a transcript to its captured requests for the Peak context link — but it is still optional and
  unchecked by `isAuditSidecar`, since legacy sidecars predate it. Once those age out, should the
  guard require it?
- Attribution is per session id, not per thread: a session id covers the main agent, its
  subagents, and one-shot helpers, so a thread's Peak context can be a subagent's request. The
  thread key is a hash of the session id plus the first user message, which only the request
  body carries — recomputing it would mean reading every `.request.txt` (megabytes each) instead
  of the sidecars. Worth having the proxy write the thread id into the sidecar?
- The errors page is the one session view with no SSE subscription and no **Live** indicator —
  worth streaming it too, or is an error list stable enough to leave on the one-shot query?

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Live session graph](live-session-graph.md)
- [`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md)
