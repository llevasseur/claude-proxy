---
type: feature
title: Live session graph
description: A full-bleed page that draws a session's steps as a snake and each subagent it spawned as an indented branch beneath it, updating as the run proceeds.
tags: [dashboard, frontend, usage]
timestamp: 2026-07-24
---

# Live session graph

## Summary

A **Live graph** page (`/sessions/graph`) in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md)
that draws one session at a time as a tree: its appended steps chained into a folding
snake, and every subagent it spawned hanging beneath the step that started it as an
indented branch with a return edge back into the parent. The page fills the whole content
area, pans and zooms, and refreshes on its own so steps appear as a run proceeds.

## Motivation

The [Sessions](session-transcripts.md) list is flat — one row per transcript, newest first.
But a Claude Code session spawns subagents, and each subagent runs under its parent's
session id with its own conversation root, so the proxy writes it as a *separate*
transcript with its own thread id. In a list, a delegated run is indistinguishable from a
top-level one: nothing tells you which row was the parent, which of nine rows were its
fan-out, how deep the nesting went, or which are still running. The relationship *is*
inferable from the observed request stream — a parent's `Agent(…)` step, and sibling
transcripts in the same session id — and the graph is where that inference is drawn:
parentage, spawn order, depth, where each branch's result rejoined the parent, and what the
parent did while the branch was in flight.

## Behavior

- **Tree reconstruction** (`packages/core/src/sessions.ts`) — `spawnAgentType` reads the
  `subagent_type=` argument off a transcript's `Agent(…)` / `Task(…)` tool-call line (those
  two names are the whole `SPAWN_TOOLS` set); `isAgentSpawn` is the boolean form.
  `linkAgentSessions` groups transcripts by `session` id into one agent family and lets each
  spawn claim, in order, the earliest unclaimed transcript in the family that started no
  earlier than the spawner (claiming is one-to-one, cycle-guarded, and skips transcripts
  with no start time). Each thread gets a `SessionAgentLink`: `parentThreadId`,
  `spawnIndex`, `agentType`, `returnIndex` (the parent's first non-spawn step after the
  spawn — where the branch's result flows back), `depth` (0 for a top-level session, 1 for
  its subagents, and so on), and `childThreadIds` in spawn order.
- **Inferred, not reported** — nothing on the wire names a parent/child pair, and individual
  transcript lines carry no timestamps, so pairing is positional: start-time order within a
  session id, bounded by the spawn count. Leftovers stay top-level, and a spawn whose
  transcript was never captured goes unmatched (the inspector says **no transcript captured**).
- **Canvas** — the selected session's root box then its steps (`task` / `decision` / `tool` /
  `error` / `done`) folded boustrophedon-style, so a long run wraps instead of running off
  the right. Rows-per-fold follow the viewport: 1 (vertical, mobile), 3, 5, or 7. Drag to
  pan, wheel to zoom about the cursor, plus **−**, **+**, **Fit**, and **Fullscreen** /
  **Exit**. A spawn step is labelled by the agent type it started rather than its raw signature.
- **Subagent branches** — `layoutTree` recurses: a step that spawned a subagent hangs that
  subagent's own snake beneath its row inside an indented band, and the parent's later rows
  resume below the band, so what the parent did while the branch ran stays visible beside it.
  The band's head reads **subagent** · its agent type · its label · **in flight** or
  **returned**. A dashed **spawn** edge crosses from the parent step into the branch root; a
  dashed, arrowheaded **return** edge carries the branch's last step back to the parent step
  it rejoins — so a parallel batch of spawns converges on one parent step. A branch whose
  parent hasn't stepped past the spawn (`returnIndex === null`) is marked in flight.
- **Collapsible rail** — a **Sessions** rail (272 px) nests the same tree: **▾** / **▸** fold
  toggles per parent, an agent-type tag on subagent rows, and per-row updated time, step
  count, agent count, error count, and an **in flight** marker. **«** collapses it to a 38 px
  strip showing only a vertical **N sessions** label and an explicit **»** to reopen, so
  collapse survives a cursor sitting where the rail used to be and stays keyboard- and
  touch-reachable. Picking a subagent canvases its top-level family and centers that branch.
- **Inspector** — clicking a box or a band head opens a **Node details** panel (**Esc**
  closes). For a step: **Task**, **Tool**, **Detail**, **Step** index, and for a spawn the
  **Subagent** it started, its **Status** (in flight, or *returned into parent step #n*), and
  **Show its branch →**. For a session or subagent root: **Agent type**, **Status**,
  **Spawned by**, **First task**, tasks/tools/errors stats, thread id, **Model**, **Started**,
  **Updated**, and **Open transcript →**.
- **Toolbar** — a live dot beside a count of sessions, the canvased session's steps, and its
  subagents with how many are in flight; a legend for **task**, **decision**, **tool**,
  **subagent**, **error**, **done**.
- **Staying live** — the page re-fetches `GET /api/sessions/graph` every 4 s (the dot lights
  while a fetch is in flight) and only refits the view when the session or fold width changes,
  so arriving steps never yank the viewport. Note this page polls; the SSE streams
  (`/api/sessions/stream`, `/api/sessions/session/stream`) back the Sessions list and one
  session's detail, and `/api/sessions/graph` has no SSE counterpart.

The data path is `packages/core/src/sessions.ts` → `server` → `apps/admin`: core parses each
transcript into `SessionMeta` plus an ordered `SessionNode[]` (`parseSessionNodes`) and
reconstructs the family tree (`linkAgentSessions`); the server's `listSessionGraphs` reads
every transcript once and merges the two into `SessionGraph` rows, which `buildSessionsGraph`
serves from `GET /api/sessions/graph` as `{ sessions, meta: { sessionsDir, total } }`; the
admin page lays those rows out and draws them. The browser never parses raw Markdown, and the
proxy is untouched — this is read-only over transcripts it already writes.

## Acceptance criteria

- [x] `/sessions/graph` renders one session's steps as a folding snake, full-bleed, with pan,
      cursor-anchored zoom, **Fit**, and fullscreen.
- [x] `spawnAgentType` / `isAgentSpawn` detect an `Agent(…)` / `Task(…)` step and read its
      `subagent_type`; a spawn with no recorded type still counts as a spawn.
- [x] `linkAgentSessions` reconstructs parent, spawn index, agent type, return index, depth,
      and children per transcript, one-to-one within a session id, including nested subagents.
- [x] `GET /api/sessions/graph` returns every transcript's listing row, node stream, and link
      fields in one payload.
- [x] A subagent draws as an indented band beneath the step that spawned it, with a dashed
      spawn edge in and an arrowheaded return edge into the parent step it rejoins.
- [x] An in-flight subagent (parent hasn't stepped past the spawn) is labelled as such on the
      band, in the rail, in the toolbar count, and in the inspector.
- [x] The rail nests subagents with fold toggles, and **«** collapses it to a 38 px strip with
      an explicit **»** to reopen.
- [x] New steps appear without a reload, and the view does not re-fit or re-center on refresh.
- [x] No proxy changes; the feature is read-only over existing session transcripts.
- [x] `parseSessionNodes`, `spawnAgentType`, and `linkAgentSessions` are unit-tested
      (`packages/core/test/sessions.test.ts`); `pnpm typecheck` and `pnpm test` pass.

## Open questions

- Whether to move the page onto SSE. Every other live surface streams, but the graph polls
  `/api/sessions/graph` every 4 s and rebuilds the whole payload each time — every transcript
  in the log dir, nodes and all — regardless of what changed.
- The limits of spawn detection are structural. Only tool calls literally named `Agent` or
  `Task` are spawns, so a subagent started any other way (a skill that runs in a subagent, a
  teammate resumed via `SendMessage`) leaves its transcript stranded at top level. And the
  proxy records at most one identifying argument per tool call, chosen by a fixed key order in
  `proxy/session.mjs`, so `subagent_type` is only in the line when the call actually passed it
  — otherwise the branch is detected but labelled generically. Worth deciding whether to widen
  the tool set, or record the spawn relationship at capture time instead of inferring it later.
- Pairing accuracy on a fan-out. Spawns claim transcripts in start-time order, not by matching
  a spawn to *its* subagent, so a parallel batch that starts in a different order than it was
  requested can attach the wrong branch to the wrong spawn — and nothing in the payload marks
  a pairing as uncertain.
- Transcripts that can never be linked: one with no `session:` header, one with no `started:`
  time, or a lone transcript in its family. Also, a thread id is a hash of session id plus
  first user text, so two subagents given byte-identical prompts in one session collapse into a
  single transcript — one branch instead of two.
- Whether the canvas should ever show more than one top-level family at a time (today it draws
  the selected session and its descendants only).

## Related

- [Session transcripts](session-transcripts.md) — the flat list and per-session transcript view
  this page branches out of.
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard the **Live graph** station lives in.
