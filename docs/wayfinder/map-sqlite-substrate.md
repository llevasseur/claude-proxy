---
type: map
title: "Map: SQLite as the query substrate over the log files"
description: Wayfinder map for the six-slice migration from doc-shaped logs to an indexed SQLite view — destination, slice ledger, and the runbook for resuming cold.
label: wayfinder:map
slug: map-sqlite-substrate
timestamp: 2026-08-02
---

# Map: SQLite as the query substrate over the log files

## Destination

Every read path in `server/` answers from an **indexed, joinable SQLite view**
of `logs/` instead of a full `readdir` + `readFile` scan rebuilt per request —
with the log files still on disk, still the source of truth, and every current
API response still byte-identical. Reaching the destination means all six slices
below are checked, and each one landed only because a parity harness proved the
DB answer matched the file answer exactly, for every archived day.

The engine decision, the disposable-view invariant, and the `/revive` hard
constraint are recorded in
[ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md). Read it before
picking up a slice; this map is the ledger, the ADR is the reasoning.

## Standing rules for every slice

- `logs/` is the sole source of truth. The DB is a **disposable materialized
  view** — every table reconstructible by re-ingesting, total recovery is
  `rm logs/claude-proxy.db && pnpm --filter server ingest`.
- **Authored state never goes in** (until slice 6 says otherwise, explicitly):
  `logs/suggestion-status.json` and device settings stay JSON files.
- **Do not touch `proxy/`.** It is load-bearing — if it breaks, Claude Code
  stops working. The server does all ingest.
- No new dependencies: `node:sqlite`, raw SQL, prepared statements,
  `PRAGMA user_version`.
- A slice is not done until the parity harness is green for its routes across
  every archived day, on the **full** JSON. A diff you cannot name is a bug.

## The six slices

- [x] **Slice 1 — Foundation and audit rows.**
      `node:sqlite` in WAL mode at `logs/claude-proxy.db`; schema versioning via
      `PRAGMA user_version`; engines floor raised to `>=22`. Tables `request`,
      `request_tool`, `request_rate_limit`, `request_skipped`,
      `ingest_watermark`. Idempotent watermarked ingest on server start plus an
      `fs.watch`, and an explicit `pnpm --filter server ingest`. The
      `SidecarSource` seam with file- and DB-backed implementations. **The
      parity harness itself**, wired to `/api/usage`, `/api/tools`,
      `/api/summary`, `/api/trends`, generalized so later slices register
      routes. Shadow mode behind `SHADOW_DB`. Reads stay file-backed.

- [x] **Slice 2 — Sessions.**
      `session` and `session_node` tables from `logs/sessions/<threadId>.md`
      and its `.nodes.jsonl` / `.state.json` sidecars. Registers
      `/api/sessions*` and `/api/context*` with the parity harness. Reads stay
      file-backed. Note the `/revive` constraint: the session `.md` files keep
      being written, no exceptions.
      *Landed with a third table, `session_node_text`, for the sparse
      `.nodes.jsonl` sidecar — it can name an index the transcript no longer has,
      so it cannot hang off `session_node`. Transcripts are the mutable part of
      `logs/`, so their watermark is per-file (`bytes` + `modified`) rather than
      the dir-level one slice 1 uses. `/api/context/detail|message|tool` are
      deliberately unregistered: they read a `.request.txt` body off disk and
      touch no indexed column.*

- [x] **Slice 3 — Command runs. DEPENDS ON SLICE 2.**
      The run / turn / step tree, plus waste and patterns from
      `packages/core/src/commands.ts`. Registers `/api/commands*`. It needs the
      session rows from slice 2 to hang the tree off, so it cannot start early.
      *Landed against `logs/commands/runs.jsonl` rather than the transcripts: a
      run is **distilled** by `reconcileCommandRuns` and then **stored**, so the
      store is the source the substrate mirrors. That is why `command_run`
      carries a `document` column beside the normalized tree —
      `readCommandRuns` deliberately keeps records it does not fully understand
      (`isCommandRun` checks three identity fields), and half a record's fields
      are optional, so rebuilding one from columns could not tell "key absent"
      from "key held the default" and would drop a future writer's fields the
      moment slice 5 flips reads. The tables exist to be *queried*; the document
      is what is *served*. One mutable file means a third watermark shape, a
      `file_watermark` row keyed on the path — and its own `fs.watch`, since
      `logs/commands/` is not covered by the non-recursive watch on `logs/`. The
      installed catalogue under `~/.claude/commands` is **not** indexed: it lives
      outside `logs/`, so both backings read it identically — but the parity
      harness pins it on `ParityContext.commandsDir` so a `/sync` cannot move it
      between the two replays.*

- [x] **Slice 4 — The remainder.**
      Projects, jobs, suggestions, errors, skim, withheld, filters. Whatever
      read path is still scanning after slice 3 gets a table and a registered
      parity route. Authored suggestion *status* still stays out — only the
      derived suggestion data is indexed.
      *Landed with **no new tables**. Every read path still scanning after slice
      3 turned out to be a different aggregation over rows slices 1 and 2 already
      hold, so the work was threading `SidecarSource` through the last five
      builders (`buildSkim`, `buildSkimTrend`, `buildWithheld`,
      `buildSuggestionStatus`, `applySuggestionStatus`) and registering
      `/api/skim`, `/api/skim/trend`, `/api/withheld` and
      `/api/sessions/suggestions/status`. Errors were already wired by slice 2.
      Four of the names on this list are deliberately **out of scope** rather
      than overlooked: `/api/projects`, `/api/jobs` and `/api/hooks-plugins` read
      `~/.claude/projects`, `~/.claude/jobs` and `~/.claude/settings.json` — all
      outside `logs/`, which ADR 0004 scopes the substrate to, and none of them
      rebuildable by re-ingesting, so indexing them would put the only copy of
      something in a disposable view. `/api/filters` is a static inventory with
      no disk read at all. That is the same boundary that kept
      `~/.claude/commands` unindexed in slice 3. The suggestion-status route is
      registered for its **derived** half only: the bucket/suggestion join comes
      from the indexed transcripts, while the flags stay in
      `logs/suggestion-status.json` and are read as a file on both sides. The
      real-corpus snapshot grew accordingly — `.request.txt` bodies are now
      hardlinked in, because `/api/skim` parses them for the last user turn and
      omitting them would have made both sides read `null` and the route's parity
      vacuous.*

- [ ] **Slice 5 — Graduation.**
      Parity green across **all** routes for **every** archived day. Only then
      flip reads to DB-backed by default, with the file scan retained as a
      fallback. This is the slice where the substrate starts doing real work,
      and it is still reversible: the files are untouched and the fallback is
      one flag away.
      *Known blocker to resolve here, from slice 2: `dbSource.readSession`
      returns row-derived `meta` / `bytes` / `modified` alongside a freshly-read
      `content`. A transcript appended to since the last ingest therefore yields
      an internally inconsistent object — `bytes` disagreeing with the content's
      length, `meta` trailing it. Reads being file-backed makes that harmless
      today, and the parity harness cannot catch it by construction, because it
      snapshots the corpus precisely to freeze those appends. Flipping this
      route to DB-backed reads has to settle it: either serve the whole answer
      from one read, or re-`stat` and re-parse when the row is behind the file.*

- [ ] **Slice 6 — Cutover. DELIBERATELY UNSPECIFIED.**
      The shape is known: the proxy writes rows plus content-addressed blobs at
      `blobs/<sha256>`, authored state moves in, and `/revive` is taught to read
      the DB. The details are **not** to be designed until slice 5 has proven
      the schema against real traffic, because this is the one irreversible
      step — it is where the log files stop being the source of truth, and a
      schema mistake carried into it cannot be fixed by deleting the database.
      Do not pre-plan it here.

## Resume runbook

*Written for whoever picks this up next — a human returning after a week, or an
agent starting cold with no memory of any of it.*

**Where the campaign state lives.** In this file, on `main`. Nothing else tracks
it: no ticket system, no external board, no session memory. Each `/god` run
merges its slice's PR into `main`, and that PR is what checks the slice's box
here. So **the git history of `main` is the ledger**, and this map is its
current reading. If the map on `main` says a slice is unchecked, that slice did
not land, whatever any branch or transcript claims.

**To resume:**

1. Read this map **on `main`** (not on a feature branch — a branch may check a
   box that never merged).
2. Find the **first unchecked slice**.
3. Run `/god` with that slice's criteria, written out in full. `/god` takes it
   from criteria to a reviewed, green, merged PR without a human in the loop.
   Include the standing rules above in the criteria — an agent with no context
   will not infer "do not touch `proxy/`" on its own.
4. That merge checks the box, and the next resume starts from the next slice.

**If a slice died mid-flight** — a rate limit, a crashed session, a
half-finished branch with no PR — use `/revive <session-id>` for **that slice
only**. The division of labour is strict: **the map handles the campaign,
`/revive` handles a single task.** Do not try to revive "the migration"; revive
the one run that died, let it finish and merge, then come back here.

Because each slice is one `/god` run and one merge, **a rate-limit death costs
at most one slice** — everything already merged is on `main` and checked here,
and the resume procedure above is the whole recovery.

**Sanity checks before starting a slice:**

- `git log --oneline -5` on `main` — confirm the previous slice's squash merge
  is actually there.
- `pnpm --filter server ingest` — rebuilds the view from the logs; it should
  finish clean. If it does not, fix that before adding a schema on top of it.
- `pnpm --filter server test` — the parity suite must be green *before* you
  change anything, or you cannot tell your own diffs from inherited ones.
