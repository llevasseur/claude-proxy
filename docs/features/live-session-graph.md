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
A subagent runs under its parent's session id with its own conversation root, so the proxy
writes it as a *separate* transcript with its own thread id, and a list cannot say which row
was the parent, which rows were its fan-out, how deep the nesting went, or which are still
running. The relationship *is* inferable from the observed request stream — a parent's
`Agent(…)` step, and sibling transcripts in the same session id — and the graph is where that
inference is drawn: parentage, spawn order, depth, where each branch's result rejoined the
parent, and what the parent did while the branch was in flight.

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
  `error` / `done`) folded boustrophedon-style, so a long run wraps. Rows-per-fold follow the
  viewport: 1 (vertical, mobile), 3, 5, or 7. Drag to pan, wheel to zoom about the cursor,
  plus **Fit**, a larger-nodes toggle, and fullscreen. A spawn step is labelled by the agent
  type it started rather than its raw signature.
- **Subagent branches** — `layoutTree` recurses: a step that spawned a subagent hangs that
  subagent's own snake beneath its row inside an indented band, and the parent's later rows
  resume below the band. The band's head reads **subagent** · its agent type · its label ·
  **in flight** or **returned**. A dashed **spawn** edge crosses from the parent step into the
  branch root; a dashed, arrowheaded **return** edge carries the branch's last step back to the
  parent step it rejoins, so a parallel batch of spawns converges on one parent step. A branch
  whose parent hasn't stepped past the spawn (`returnIndex === null`) is marked in flight.
- **Collapsible rail** — a **Sessions** rail (272 px) nests the same tree: **▾** / **▸** fold
  toggles per parent, an agent-type tag on subagent rows, and per-row updated time, step
  count, agent count, error count, and an **in flight** marker. **«** collapses it to a 38 px
  strip showing only a vertical **N sessions** label and an explicit **»** to reopen, so
  collapse survives a cursor sitting where the rail used to be and stays keyboard- and
  touch-reachable. Picking a subagent canvases its top-level family and centers that branch.
- **Step text from the Request breakdown** — a transcript is a *lossy* render: `proxy/session.ts`
  gists every line to 160 chars and every recorded tool argument to 60, so a prompt or a command
  line arrives at the graph cut off. The same steps are held whole in the captured requests, so
  the text is re-read from there. `deriveSessionNodes` runs the proxy's own grammar
  over a captured body's `messages[]` and emits the identical `SessionNode[]` stream untruncated;
  `mergeSessionNodes` lays that over the transcript's, which stays the authority on *which* steps
  exist (the agent linkage is built from its positions, so the merge preserves every `index`).
  The two are not positionally aligned: a transcript accumulates every request ever seen, so it
  also carries turns no single body holds — notably Claude Code's one-shot spinner prompts landing
  mid-thread — and a captured body can equally hold turns the transcript gisted differently. So the
  merge walks both streams and pairs by expanding each gist (`isSameStep` allows for the `…`, which
  for a tool call sits inside the parens); where they disagree it *re-syncs*, searching outward
  along growing diagonals for the nearest pairing that skips fewest steps on either side, within a
  24-step window. Advancing only the transcript on a mismatch (the earlier behaviour) desynced the
  streams permanently: one differently-worded step stranded every later one at its gist, which is
  why equal-length 132/132 streams matched only 100. A step with no pairing keeps its abbreviated
  transcript text, so the graph degrades rather than breaks.
- **Each step carries its message index** — `deriveSessionNodes` records the `messages[]` position
  a step was read from on the node itself (`message`), so the drawer can name the exact turn behind
  a step. It is `null` on a step read off a transcript,
  which records no such position, and the merge carries the derived value through.
- **Interruptions and side trails** — a run can be cut off two ways, both landing in the same
  grammar. Pressing **Esc** in Claude Code makes the CLI prepend `[Request interrupted by user]`
  (or `… for tool use`) to the next user turn, which `proxy/session.ts` already writes into the
  transcript; `splitInterruption` strips that marker off the task text and reports `user` /
  `tool-use`. **Stop** in the dashboard never reaches the wire — the child is killed before
  it answers — so `recordInterruption` (`server/src/chat.ts`) appends `- interrupted: <why>`
  (`stopped` / `timeout` / `limit`) to that thread's transcript, the only durable record a chat
  has. Either way the interruption is a *flag*, never a node: the step it landed after is marked
  `interrupted`, the step that resumed is marked with the `interruption` kind, and every `index`
  stays put (the agent linkage is built from them). `mergeSessionNodes` keeps the transcript's
  flags, since a captured request cannot carry the dashboard's own stop.
- **Drawing the cut** — the severed step wears a coral ring and a torn right edge. `runsOf`
  splits the node stream at each resume, so the snake ends there and the remainder is laid out
  again inside an inset **side trail** — a coral dashed frame headed **interrupted** · why
  (*interrupted by user*, *interrupted mid-tool*, *stopped from the dashboard*, *timed out*,
  *hit its ceiling*) — reached by a distinct dashed **sever** edge dropping out of the severed
  step. Trails share one indent rather than nesting. The toolbar counts them and the legend
  gains an **interrupted** swatch.
- **Inspector** — clicking a box or a band head opens a **Node details** panel (**Esc**
  closes). For a step: **Task**, **Tool**, **Detail**, **Step** index, and for a spawn the
  **Subagent** it started, its **Status** (in flight, or *returned into parent step #n*), and
  **Show its branch →**. For a session or subagent root: **Agent type**, **Status**,
  **Spawned by**, **First task**, tasks/tools/errors stats, thread id, **Model**, **Started**,
  **Updated**, **Open transcript →**, and **Open request breakdown →** for the captured request
  the step text came from (or a note that none matched).
- **The whole turn, in the drawer** — a step that paired with a captured request also gets a
  **Request message** field: the turn it was read out of, whole, fetched per open drawer from the
  same endpoint the [Request breakdown](context-size-analytics.md)'s drill-down uses, labelled
  *#n of N · role*, and clamped like any other long value (an expanded one scrolls inside the
  drawer rather than growing it). **Open this step's message →** links straight to
  `/context/$file/message/$index` — that step's own message in the breakdown, not the request's
  front page. A step that paired with nothing says so.
- **Where the drawer's step text comes from** — not the captured-request merge. The drawer asks
  `getSessionNodeTexts` (`GET /api/sessions/node-text?id=`) for the thread's `.nodes.jsonl`
  sidecar, which the proxy writes as it appends the transcript, so a selected step's full text is
  one indexed lookup rather than a scan. The canvas still uses the merge for the gist-level view.
- **Expanding the details** — untruncated step text runs to thousands of characters, so the
  drawer opens up two ways: **⇤** / **⇥** in its header widens it from 360 px to 720 px (sticky
  across selections), and any value past 280 characters folds to six lines behind a **Show all
  N characters** toggle. Hover tooltips on the canvas stay capped at 300 characters.
- **Fit accounts for both overlays** — the rail and the details drawer sit *over* the canvas
  rather than shrinking it, so **Fit** measures the slice they leave free (both widths read live,
  since each animates and the drawer is absent when nothing is selected) and frames the graph
  there. A widened drawer on a narrow viewport cannot squeeze the free area to nothing. Opening
  the drawer does not itself refit; **Fit** is the explicit control.
- **Toolbar** — a live dot beside a count of sessions, the canvased session's steps, and its
  subagents with how many are in flight; a legend for **task**, **decision**, **tool**,
  **subagent**, **error**, **done**. Its controls are **Fit** and two icon toggles: larger
  nodes, and fullscreen. There are no **−** / **+** buttons — zoom is the wheel (⌘-scroll or
  pinch), which the **Fit** button's tooltip spells out.
- **Larger nodes** — steps are drawn as two-line gists by default. The toggle re-lays the
  canvas out at a roomier box size (a step goes 168×64 → 320×216) and lifts the title clamp
  from 2 lines to 8, so a step's whole label reads on the canvas. Geometry is a `Sizes` preset
  threaded through `layout` / `layoutTree` / `layoutRun` rather than module constants, so both
  sizes share one layout path. Toggling deliberately does **not** refit — the zoom is left
  alone and the boxes simply grow on screen; **Fit** reframes on demand.
- **Staying live** — the page re-fetches `GET /api/sessions/graph` every 4 s (the dot lights
  while a fetch is in flight) and only refits the view when the session or fold width changes,
  so arriving steps never yank the viewport. Note this page polls; the SSE streams
  (`/api/sessions/stream`, `/api/sessions/session/stream`) back the Sessions list and one
  session's detail, and `/api/sessions/graph` has no SSE counterpart.

The data path is `packages/core/src/sessions.ts` → `server` → `apps/admin`: core parses each
transcript into `SessionMeta` plus an ordered `SessionNode[]` (`parseSessionNodes`) and
reconstructs the family tree (`linkAgentSessions`); the server asks its read source for
`listSessionGraphs` — the SQLite substrate by default, which answers from its tables without
reading the directory at all, and the original transcript scan when `DB_READS=0` — and either
way the two are merged into `SessionGraph` rows, which `buildSessionsGraph`
serves from `GET /api/sessions/graph` as `{ sessions, meta: { sessionsDir, total } }`; the
admin page lays those rows out and draws them. The browser never parses raw Markdown. The graph
reads only the transcripts the proxy already writes; the drawer's full step text is the one part
that needed the proxy, which now emits a `<threadId>.nodes.jsonl` sidecar alongside the
transcript. The one write back from the dashboard is `recordInterruption` appending a dashboard
**Stop** to an existing transcript; it never creates one, so a thread the proxy hasn't flushed
yet is skipped rather than left headerless, and the proxy tracks its own progress by message
count, not file offset, so the extra line can't desync it.

Step text takes a second path over the same logs. `GET /api/sessions/graph/nodes?id=<threadId>`
(`buildSessionGraphNodes`) walks the canvased session and every descendant into one agent family,
scans the sidecars carrying the family's session ids **newest-first** capped at 60 requests, and
hashes each body back to the thread that produced it with `threadIdForBody` — the server-side
mirror of the `threadIdFor` in `proxy/session.ts` that named the transcript in the first place.
The scan's floor is the family's earliest transcript `started`, read through `reportDay`: that start
is a UTC instant, but the sidecar reader narrows by *reporting* day in `REPORT_TZ`, so the floor is
derived on the same clock the filter compares against. A floor taken straight off the UTC prefix
excluded every request the family ever made — Eastern runs behind UTC, so an evening session carries
a `started` whose UTC day is already tomorrow, and every session started in that nightly window
stayed wholly at its transcript gists.
The richest snapshot found per thread supplies its `deriveSessionNodes` stream, returned as
`{ rootThreadId, threads: [{ threadId, file, messageCount, nodes }], meta }`. The admin page
fetches it per canvased session on a 20 s interval — far heavier than the 4 s transcript poll,
since each candidate is a whole request body — and merges it in. Threads with no captured request
left are simply absent from `threads`, and keep their transcript text.

## Acceptance criteria

- [x] `/sessions/graph` renders one session's steps as a folding snake, full-bleed, with pan,
      cursor-anchored zoom, **Fit**, a larger-nodes toggle, and fullscreen.
- [x] The larger-nodes toggle grows every box and unclamps its label so a step's whole text
      reads on the canvas, and toggling back restores the compact layout.
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
- [x] The graph reads existing session transcripts; the drawer's step text reads the proxy's
      `.nodes.jsonl` sidecar over `/api/sessions/node-text`, and the dashboard's only write is
      appending a **Stop** to a transcript that already exists.
- [x] A Claude Code **Esc** (`[Request interrupted by user]`, with and without ` for tool use`)
      and a dashboard **Stop** (`- interrupted: stopped` / `timeout` / `limit`) both parse into
      the same `interrupted` / `interruption` flags, and the marker is stripped from the step text.
- [x] An interruption never adds or shifts a node — every `index` survives it, and
      `mergeSessionNodes` keeps the transcript's flags over a captured request's.
- [x] The severed step is styled distinctly, and the run resumes in an inset side trail reached
      by its own sever edge, headed with why it was cut; the toolbar counts the trails.
- [x] `recordInterruption` skips a thread whose transcript the proxy hasn't flushed rather than
      creating a headerless one (`server/test/chat-interruption.test.ts`).
- [x] Step text is re-read from the captured requests, so a prompt or command line the
      transcript gisted to 160 chars shows in full.
- [x] `mergeSessionNodes` preserves every transcript `index` (the agent linkage depends on
      them) and re-syncs across turns either side holds alone, so one differently-worded step
      no longer strands every later step at its gist.
- [x] `GET /api/sessions/graph/nodes` resolves the canvased session *and* its subagents to
      their own captured requests, and 404s an unknown thread id.
- [x] A session whose `started` falls after midnight UTC but on the previous reporting day still
      finds its requests (`server/test/session-graph-nodes.test.ts`).
- [x] Each expanded step carries the `messages[]` index it was read from, the drawer shows that
      whole message, and **Open this step's message →** deep-links to it in the Request breakdown.
- [x] With larger nodes on, every box keeps a fixed height and clips its label — a step holding
      thousands of characters does not grow its box.
- [x] **Fit** frames the graph into the area left free by the rail *and* the details drawer.
- [x] The drawer widens on demand, and long values expand behind a **Show all** toggle.
- [x] `parseSessionNodes`, `spawnAgentType`, `linkAgentSessions`, `deriveSessionNodes`,
      `firstUserText`, `isSameStep`, and `mergeSessionNodes` are unit-tested
      (`packages/core/test/sessions.test.ts`), and `threadIdForBody` is checked against the
      `threadIdFor` it mirrors by importing `proxy/session.ts` itself
      (`server/test/session-graph-nodes.test.ts`); `pnpm typecheck` and `pnpm test` pass.
- [x] Every row of `/api/sessions/graph` carries a `liveness` verdict — `running`, `quiet`,
      `finished` or `unknown` — derived from how long ago the transcript was appended to and
      whether it ended on an outcome, and the rail draws a branch's verdict beside its
      **in flight** marker. `GET /api/sessions/liveness` is the same verdict without the node
      streams, for asking from a terminal. Both take `now` as a parameter, so the file- and
      SQLite-backed sources answer identically and parity holds
      (`packages/core/test/liveness.test.ts`, `server/test/sessions-liveness.test.ts`).

## Open questions

- Whether to move the page onto SSE. Every other live surface streams, but the graph polls
  `/api/sessions/graph` every 4 s and rebuilds the whole payload each time — every transcript
  in the log dir, nodes and all — regardless of what changed.
- ~~Spawn detection is structurally limited~~ and ~~pairing accuracy on a fan-out~~ —
  **resolved for anything captured from now on.** The proxy watched the spawn happen, so it
  writes the pairing down instead of leaving it to be re-derived: a `tool_use` carrying a
  non-empty `prompt` starts a child thread, and the child's transcript gets `- parent:` /
  `- spawn:` / `- agent:` header lines naming the spawning thread, the node index of the call,
  and the agent type (`subagent_type`, else `skill`). Detection is keyed on the **argument**
  rather than the tool's name, so a spawn under a name nobody listed is still a spawn, and the
  agent type is read off the call's full input rather than the one truncated argument the
  display line kept. `linkAgentSessions` applies every recorded pairing first; only what is
  left over takes the old per-family start-time pass, and every link it makes is now flagged
  `inferred: true` on the wire, so an uncertain pairing says so. The `Agent`/`Task` allow-list
  and the start-time heuristic **stay** — they are the legacy path for transcripts written
  before the header lines, and they are tested as such — but they no longer decide anything the
  proxy saw for itself. **Both now carry the date they became legacy** —
  `agent-spawn-tool-allow-list` and `agent-link-start-time-inference` in
  `packages/core/src/fallbacks.ts`, 2026-08-07 — and `server/test/fallback-retirement.test.ts`
  fails naming them once no retained transcript predates the header lines, so "stay" has an end
  condition instead of being permanent by default. Today they stay: the archive's floor is
  2026-07-12, weeks of transcripts predate the field, and both paths are load-bearing.
  Still open: linking is bidirectional in memory only, so a spawn observed
  before its child *and* separated from it by a proxy restart falls back to inference, since the
  pending-spawn registry is not mirrored to disk the way pending titles are.
- The `liveness` verdict is deliberately **not** downstream of that linkage: it reads one
  transcript's own appends, so a mispaired branch still reports whether *it* is running. Only
  `finished`-by-`reported` leans on the linkage, since a subagent's report is recorded by its
  parent and nowhere else.
- Liveness is a read and stays one — nothing here resumes or kills a branch. It also cannot
  tell a branch stuck in a loop from one doing slow work: both append, so both read `running`.
  `quiet` is the honest limit of what an outside observer can say, and `QUIET_AFTER_MS` (ten
  minutes, sized to one long tool call) is reported in every payload rather than assumed, so
  the threshold can be argued with without re-deriving the verdict.
- Transcripts that can never be linked: one with no `session:` header, one with no `started:`
  time, or a lone transcript in its family. Also, a thread id is a hash of session id plus
  first user text, so two subagents given byte-identical prompts in one session collapse into a
  single transcript — one branch instead of two.
- Whether the canvas should ever show more than one top-level family at a time (today it draws
  the selected session and its descendants only).
- What the step-text scan should cost — now only for the canvas's merged view, since the drawer
  reads the `.nodes.jsonl` sidecar directly. It reads up to 60 whole request bodies per canvased
  family, newest-first, and re-runs every 20 s — cheap on a local log dir (~120 ms in practice)
  but unbounded as the log grows, and `meta.capped` is the only signal that older requests went
  unread. A thread whose activity falls outside that window keeps its gisted text with nothing
  in the UI explaining why. Recording the thread id in the audit sidecar at capture time would
  turn the whole scan into an index lookup.
- The merge is a heuristic, not a proof. A gist is matched by expanding its prefix, so two
  adjacent same-type steps sharing a 160-char prefix are indistinguishable; and after context
  compaction the richest captured request may predate steps the transcript already has, which
  simply keep their gisted text. Neither case is marked in the UI.
- The re-sync window is a fixed 24 steps, picked to cover the turn-level drift seen in practice
  rather than derived from anything. Past it the merge gives up and the rest of the run stays
  gisted — silently, since nothing in the UI distinguishes "no captured request" from "the
  streams drifted too far apart".
- Derived steps that pair with nothing go unplaced entirely: node indices count transcript
  positions because the agent linkage is built from them, so a step only the captured request
  knows about has no index to sit at and is dropped rather than inserted.

## Related

- [Session transcripts](session-transcripts.md) — the flat list and per-session transcript view
  this page branches out of.
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard the **Live graph** station lives in.
