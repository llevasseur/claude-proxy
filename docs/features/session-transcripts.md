---
type: feature
title: Session transcripts
description: The proxy reconstructs a per-thread conversation transcript from the requests it already observes, and the dashboard browses them live.
tags: [dashboard, usage, backend]
timestamp: 2026-08-02
scope: claude
---

# Session transcripts

## Summary

Every Claude Code request carries the full running `messages[]`, so the proxy keeps a
durable, append-only record of what each agent did with no agent-side hook: one distilled
Markdown transcript per conversation thread under `logs/sessions/`. The
[admin dashboard](admin-dashboard-for-claude-proxy-usage.md) lists those transcripts, reads
one in full, and drills into its errored tool results — all streamed live over SSE, so a
transcript grows on screen while the agent is still working.

## Motivation

The audit sidecars are per-*request*: one `.audit.json` per `/v1/messages` call, good for
token/cost/context math and useless for "what did that agent actually do?" — a conversation
is a thread of many requests. Session-level attribution was listed **out of scope** in
[`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md)
("Session-level attribution (no session ID in logs)"). Two observations made it possible after
all. Claude Code *does* send `x-claude-code-session-id` on every request — `extractSession` in
`proxy/proxy.ts` reads it, alongside the `account_uuid` / `session_id` / `device_id` ids inside
the `metadata.user_id` blob. That header alone is not enough, because one session id covers the
main agent, its subagents, and one-shot helpers; but each request replays the whole conversation,
so `proxy/session.ts` keys a thread by *(session id + a fingerprint of its first user message)*
and separates them. The blocker was a granularity problem, not a missing id.

## Behavior

- **Thread identity** — `threadIdFor` hashes `sessionId` + the thread's first real user text
  (SHA-256, first 16 hex chars). Transcripts are written to `<LOG_DIR>/sessions/<threadId>.md`,
  with a `<threadId>.state.json` progress sidecar so a proxy restart resumes instead of
  re-appending, and a `<threadId>.nodes.jsonl` sidecar of `{"i":<index>,"text":…}` records the
  full text behind each numbered step so a reader can retrieve it without re-reading the
  captured request. Growth filters noise: a thread's first sighting is buffered in memory and
  only flushed once it reappears larger, so a one-shot helper seen exactly once never reaches
  disk.
- **What a line records** — the header is written once (`# Session <threadId>`, then
  `- model:`, `- session:`, `- started:`, optionally `- title:` and `- subtitle:`), and each
  subsequent request appends only its new turns (`messages.slice(lastSeenCount)`), distilled to
  `## Task:` headings, `- decided:` (assistant text before a tool call), tool lines like
  `- Bash(command=…)` (name plus at most one allowlisted identifying arg, truncated),
  `- ✗ …` for an errored tool result, and `- done:` for an outcome. Never the system prompt,
  tool schemas, or tool-result payloads. The `.md` line stays a distilled one-liner; the full
  prose behind it lives only in the `.nodes.jsonl` sidecar.
- **Title and subtitle** — the **subtitle** is the thread's opening prompt with its injected
  `<system-reminder>` blocks stripped and whitespace collapsed, known at first sighting. The
  **title** is the CLI's own generated chat title, which arrives out of band: the CLI asks for
  it in a *separate* `/v1/messages` request under a *different* session id, so
  `isTitleRequest` recognizes it by its system prompt, `extractTitle` pulls the `{"title": …}`
  reply, and it is linked back by content (the titling request's `<session>…</session>` payload
  opens with the thread's reminder-free root prompt). A title arriving *before* its thread is
  confirmed is held and rides into the header; one arriving *after* the header was flushed is
  appended as a standalone `- title:` line — which is why the parser in
  `packages/core/src/sessions.ts` does not confine `- title:` to the header block. A user
  *renaming* a chat never hits the wire, so only generated titles are observable.
- **Sessions list** (`/sessions`) — a chat client, not a table: a `SessionsSidenav` rail of
  transcripts beside the chat pane, split into **Active** and **Resolved** sections, with a
  **Search sessions** box, a **+** button to start a new chat, a draggable divider between rail
  and pane, and a footer counting **"N active · M resolved"**. Each row shows the session's name
  over a preview line. The resolved sessions directory is a footnote under the chat
  (`logs → <dir>`). Empty state: **"No session transcripts yet."**
- **Session detail** (`/sessions/$id`) — `$id` accepts either a thread id or a dashboard chat
  session uuid, which redirects to the thread the chat became. Title and subtitle as a heading,
  then stat tiles for **Model**, **Started**, **Tasks**, **Tools**, **Decisions**, **Errors**
  (the Errors tile is itself a link — **"view details →"** — when non-zero), and **Peak
  context**, the underlying session id and file size, a **"live graph →"** link into the
  [live session graph](live-session-graph.md), a live chat panel for a thread still running, and
  a **"Transcript"** card with a **Pretty** / **Raw** toggle (rendered Markdown vs. the raw file).
- **What a session is called** — `sessionName` takes the first of the CLI's generated **title**,
  the **derived name** `deriveSessionName` computes into `meta.derivedTitle`, the **subtitle**,
  and the **first task**. The derived rank exists because a thread the CLI never titled would
  otherwise fall to a raw opening prompt.
- **Peak context → Request breakdown** — the **Peak context** tile links into the Context
  section's [request breakdown](context-size-analytics.md) (`/context/$file`) for this session's
  largest captured request, showing its real input tokens over **"request breakdown →"** and how
  many requests the session sent. `GET /api/sessions/breakdown?id=<threadId>` reads the
  transcript's session id, scans `.audit.json` sidecars from the session's start date onward
  (a session's requests never predate it), and returns the largest match. That scan is
  `resolveSessionRequests`, and it goes through the `SidecarSource` seam — by default the
  SQLite substrate answers it from its tables with no directory read — but it only ever asks for
  the **live** log directory, so a session whose day has already been archived matches nothing
  (see the open questions). Requests are attributed by the sidecar's `session.sessionId`, which
  the proxy reads off the `x-claude-code-session-id` header — that id spans the whole agent
  family, so the peak may belong to a subagent of the thread being viewed. The tile reads a
  muted **—** with the reason underneath: **"loading…"** while the lookup runs, **"no session id"** on a transcript that carries none (which skips the
  request entirely), **"lookup failed"** when the call errors, and **"no captured requests"**
  when nothing matched — including legacy sidecars written before `session` was captured.
- **Session errors** (`/sessions/$id/errors`) — **"Errored tool results captured in this
  session"**: one **"Error #n"** entry per `- ✗` line, each tagged with the **Task** it fell
  under and the **Tool** most likely responsible (the nearest preceding tool-call line, or
  *unknown*). The proxy records only a one-line gist per error, disconnected from the call that
  produced it (that call is in a prior turn), so `parseSessionErrors` re-links them, blaming
  each call at most once. Each entry carries a stable `error-<index>` anchor for deep links.
  Empty state: **"No errors recorded in this session."**
- **From an error into the turn that produced it** — each entry ends with a **"View the full
  turn · message #n →"** link onto `/context/$file/message/$index`, the Request breakdown's
  Message details page, where the failed `tool_result` is rendered in full instead of the
  transcript's one-line gist. The handle is recovered rather than stored — a transcript error
  carries no pointer back to a request. `deriveRequestErrors` walks a captured body's
  `messages[]` for `tool_result` blocks flagged `is_error`, recording each one's array position
  (one entry per block — a single user turn can return several failures), and
  `linkRequestErrors` matches those against the transcript's errors using `isSameStep`, the
  gist-aware comparison `mergeSessionNodes` already uses to recognise a truncated line's full
  original. Both are walked in order as *subsequences*, because a request holds only the turns
  in flight when it went out: one sent before a failure never saw it, one sent after a
  compaction has lost the failures before it, so a partial overlap links what it covers instead
  of nothing.
- **Which requests the errors page opens** — `resolveSessionRequests` (shared with
  `buildSessionBreakdown`, and live-directory-only as described above) returns every capture
  matching the session id, and `requestsToScan` picks at most **6** to read: the peak first, then
  an even walk along the session's timeline. Largest-first is the wrong shape — the biggest bodies
  cluster at the end of a run, and once a session has compacted they are exactly the ones that
  dropped its early failures. On a real 193-request session the only body still holding the first
  error ranked **43rd by size**, while a six-sample walk of the timeline found it. Each body links
  whatever it can and later ones only fill the gaps, so different errors can point at different
  requests and the scan stops as soon as every error has a home. Errors that budget can't account
  for — along with every error on a transcript
  carrying no session id, or whose captures have been pruned or won't parse — read a muted
  **"full turn unavailable"**; a missing link never fails the page. **A body
  [retention](retention-lifecycle.md) has evicted lands in that same bucket**: past
  `RETENTION_DAYS` (default 30) the `.request.txt` is gone while its `.audit.json` sidecar is
  kept forever, `readRequestErrorSites` swallows the read and returns no sites, and the error
  reads **"full turn unavailable"**. The transcript's own one-line gist survives — it is the
  verbatim `tool_result`, not the record of the failure, that eviction costs.
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
  static teal, amber, or coral dot.

The data path is `proxy/session.ts` (best-effort append on every observed request) →
`logs/sessions/<threadId>.md` plus its `.nodes.jsonl` sidecar →
`packages/core/src/sessions.ts` (`parseSessionTranscript`, `parseSessionErrors`,
`deriveSessionName`) → `server` (`listSessions` / `readSession` behind `GET /api/sessions`,
`/api/sessions/session`, `/api/sessions/errors`, `/api/sessions/node-text?id=` for the sidecar's
step texts, and the two SSE routes) → `apps/admin`. Every one of those server reads now goes
through the `SidecarSource` seam (`server/src/db/source.ts`,
[ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)): by default the SQLite
substrate answers the listing and metadata questions from its tables with no directory read,
`DB_READS=0` reverts every route to the original file scan, and `SHADOW_DB=1` re-runs each
build against the other backing to compare. The transcript *body* is the deliberate exception
— `readSession` returns the same `content` off disk either way, so only the metadata around it
moved into SQL. `logs/sessions/` is also untouched by retention: the archiver moves files, not
directories, so transcripts and their sidecars are never archived and never evicted. Thread
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
- [x] `/sessions` shows every transcript in a searchable Active/Resolved rail beside a chat pane;
      `/sessions/$id` shows the stat tiles plus the transcript in pretty or raw form, accepting a
      chat session uuid as well as a thread id; `/sessions/$id/errors` lists every errored tool
      result with its task and likely tool.
- [x] The sessions list and one session both update live over SSE (400 ms / 150 ms debounce,
      25 s heartbeat), with the connection state shown on screen and the one-shot query as
      fallback.
- [x] A session's detail page links to the Request breakdown of its largest captured request,
      and degrades to a muted tile when no sidecar carries the session's id.
- [x] Session-id and thread-id handling is validated server-side against path traversal.
- [x] The session parsers (`parseSessionTranscript`, `parseSessionErrors`) are unit-tested in
      `packages/core/test/sessions.test.ts`.

## Open questions

- ~~The sidecar's `session` block is optional and unchecked by `isAuditSidecar`; once legacy
  sidecars age out, should the guard require it?~~ — **dated rather than open now.** The block is
  typed as `AuditSession` and consumed (`sessionId` joins a transcript to its captured requests
  for the Peak context link), and it stays optional only for sidecars written before the proxy
  emitted it. That day is on record as `audit-sidecar-session-block-optional` in
  `packages/core/src/fallbacks.ts` — **2026-08-07** — and `server/test/fallback-retirement.test.ts`
  compares it against the oldest capture the install actually retains. So "have they aged out?"
  is a question the suite answers on every run rather than one a reader has to judge: the guard
  may require the block on the day that test names it, and not before. Today it does not — the
  archive's floor is **2026-07-12**, months of retained sidecars predate the field, and the
  branch is load-bearing.
- ~~Attribution is per session id, not per thread~~ — **resolved.** The proxy already computed
  `threadIdFor(sessionId, messages)` to name the transcript, so it now writes that id onto the
  audit sidecar's `session` block as well, and `sessionContextPeak` / `sessionContextEntries`
  prefer an exact thread match over the session-wide one. Nothing has to re-read
  `.request.txt` to recover it. The key is **omitted, not null**, when there was no root to hash
  — matching how `isAuditSidecar` already tolerates a missing `session` block, and how the
  SQLite source rebuilds it — so a legacy sidecar keeps the session-id path unchanged. What is
  still open is whether the per-thread filter should ever *replace* the session-wide fallback
  rather than only preceding it: today a thread whose requests all predate the field silently
  reads as its whole session again.
- ~~**Both request-joined views are live-day-only.**~~ **Resolved.** `resolveSessionRequests`
  now goes through `readWindow` in `server/src/db/source.ts`, which composes `logs/archive/<date>/`
  with the live root, so the Peak context tile and the errors page's "View the full turn" links
  survive `pnpm --filter @agent-proxy/claude-server maintain` archiving the session's day.
- The errors page is the one session view with no SSE subscription and no **Live** indicator —
  worth streaming it too, or is an error list stable enough to leave on the one-shot query?

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Live session graph](live-session-graph.md)
- [`2026-07-13-claude-usage-summary-design.md`](../2026-07-13-claude-usage-summary-design.md)
