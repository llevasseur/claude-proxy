---
type: feature
title: Background jobs browser
description: A device-wide page listing every ~/.claude/jobs directory, with each job's folder tree and a pretty-or-raw viewer for any file inside it.
tags: [dashboard, device, architecture]
timestamp: 2026-07-28
---

# Background jobs browser

## Summary

Two pages in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md) over
`~/.claude/jobs` — the directories Claude Code keeps for **background jobs** on this machine.
**Jobs** (`/jobs`) lists every one of them device-wide, whichever project it ran in; a job's
page (`/jobs/$id`) shows what its `state.json` says and presents the directory as a browsable
**folder tree**, where selecting any file opens it in a viewer with a **Pretty / Raw** toggle.
The listing can also **delete** a job — really remove its directory from `~/.claude/jobs` — one of
the two places in the dashboard that change the disk rather than report on it, the other being the
[device system prompt](device-system-prompt.md) editor.

Like the [config inventory](config-inventory.md), the
[project memory browser](project-memory-browser.md) and the
[device system prompt](device-system-prompt.md), and unlike the rest of the dashboard, this reads
the local filesystem rather than captured traffic.

## Motivation

A background job's directory is the only durable record of what that run did on disk — the
`state.json` it rewrites as it goes, the `timeline.jsonl` of its state changes, and a `tmp/`
holding whatever it built: logs, screenshots, throwaway scripts, scratch reports.

Two properties of that directory shape the design:

- **It is not all text, and not all small.** One `tmp/` holds a 244 KB build log full of
  terminal escapes, four PNG screenshots, and a `node_modules` with thousands of files. A viewer
  that assumes "text file, show it" produces mojibake; a walk that descends everything produces
  an unusable tree.
- **It is written by another process, right now.** Every reader is therefore tolerant rather than
  strict: a half-written `state.json` yields a husk rather than a 500, and a `timeline.jsonl`
  whose last line is incomplete reports the count it skipped.

Both views exist because the pretty view can hide the problem — the escapes themselves, JSON that
does not actually parse — and then you need the bytes.

## Behavior

- **Jobs** (`/jobs`) — every directory under `~/.claude/jobs`, newest activity first, with
  **Jobs / Running / Husks / On disk** tiles above a sortable table of **Job** (name over id,
  with the job's live status detail), **State**, **Ran in** (the working directory's last
  segment), **Files**, **Size** and **Last active**. A state word is badged by *tone* rather than
  matched exactly — Claude Code owns that vocabulary and can extend it — so `working` reads as
  busy, `done` as done, `failed` as failed, and anything unrecognised stays neutral. A directory
  with no readable `state.json` is still listed, as a **husk**: its job is gone, its scratch space
  isn't, and hiding it would misreport the disk.
- **Delete** — each row carries a `Delete` that removes that job's directory and everything under
  it. Husks accumulate and nothing else reaps them. It is a real `rm -r` with no trash behind it,
  so the control is deliberately awkward: the first click *arms* the row
  (`Delete 4.2 MB?` / `Yes, delete` / `cancel`), only one row is armed at a time, and a job the
  server would refuse is disabled up front rather than failing after the click. What was removed
  is then stated — name, file count, bytes freed and the path — above the table it just changed.
  A **running** job cannot be deleted at all: its daemon is still writing there. Stop it first.
- **A job** (`/jobs/$id`) — **State / Files / Started / Last write** tiles, then a **Job** card
  with what it was asked to do and a field grid (state, detail, working directory, agent, model,
  template, backend, session id, when it first finished). **What it produced** lists the links
  the job recorded — a PR it opened is a live link. **In flight at the last write** shows the
  tasks the state file had running, labelled as the snapshot it is rather than a live list.
- **Files** — the directory as a folder tree, directories before files, each alphabetical, with
  a file count or size per row and per-kind icons. Directories collapse; the tree opens on
  `state.json`, the file that explains the rest. `node_modules`, `.git` and friends are **listed
  but never descended into** (marked `not walked`), symlinks are **listed but never followed**
  (marked `link`), and the walk is bounded at 4000 entries and 8 levels, saying so when it stops
  early.
- **The viewer** — a **Pretty / Raw** toggle over whatever is selected:

  | Kind | Pretty | Raw |
  |------|--------|-----|
  | `json` | re-indented at two spaces, keys coloured apart from values | the bytes |
  | `jsonl` | one block per record; a `timeline.jsonl` renders as badged state changes with timestamps and line numbers | the lines |
  | `markdown` | rendered | the source |
  | `log` | terminal escapes stripped and each line's carriage-return redraws collapsed to the frame left on screen | every frame, escapes and all |
  | `code` | numbered lines, syntax coloured | unnumbered, unwrapped |
  | `text` | numbered, wrapped | the bytes |
  | `image` | inlined | the base64 |
  | `binary` | not read, and says so | not read |

  Line numbers come from a CSS counter, so selecting the block copies the code without them.
  Pretty rendering stops at 3000 lines and points at Raw for the rest.

Data flows `~/.claude/jobs` → `server` → `packages/core` → `apps/admin`. The server walks the
directory and reads files (`server/src/jobs.ts`); the shaping is pure and lives in core —
`normalizeJobState`, `jobStateTone`, `parseJobTimeline`, `jobFileKind` and `buildJobTree` in
`packages/core/src/jobs.ts`, and the viewer transforms `stripAnsi`, `prettifyLog`,
`formatJsonText`, `codeSyntax` and `highlightSource` in `packages/core/src/code-view.ts`. The
jobs directory is `~/.claude/jobs`, overridable with `CLAUDE_JOBS`. Endpoints are `GET /api/jobs`
(the list), `GET /api/jobs/job?id=` (state + tree), `GET /api/jobs/file?id=&file=` (one
file's contents) and `POST /api/jobs/delete` (remove one directory). The delete replies with the
refreshed listing as well as what it removed, so the page never re-renders a row that is gone.

`highlightSource` is deliberately a tokenizer over *conventions*, not languages — `c-like`
(`//`, `/* */`, back-tick strings), `hash` (`#` comments), `json` (keys apart from values) and
`plain` — because mis-colouring the remainder of a file is worse than leaving something plain.
An unterminated `'`/`"` ends at its newline so one stray quote cannot restyle everything below
it; only back-ticks span lines.

## Security

The id and the file path both arrive from the URL, so both are validated before anything is read,
and the read is confined to the job directory three ways over:

- The **id** must match `^[0-9A-Za-z][0-9A-Za-z._-]*$` *and* resolve to a direct child of the
  jobs root.
- Every **path segment** is rejected if it is empty, `.`, `..`, or contains a backslash.
- The resolved path is then **realpath'd** and confirmed to still sit inside the realpath'd job
  directory — which is what stops a symlink an agent left in its own `tmp/` from becoming a way
  to read the rest of the filesystem. Both sides are resolved so a symlinked home does not read
  as an escape.

Every read is read-only: `server/src/jobs.ts` uses only `readdir`/`stat`/`readFile`/`realpath` for
them, and the read routes are GETs under the same open CORS as their neighbours — a non-GET on one
of them is refused with a 405 (`Allow: GET, OPTIONS`) rather than reaching a handler. Text is capped at
512 KB (marked truncated) and an inlined image at 4 MB, so no single file can exhaust the response.
A file whose bytes contain a NUL is reported as binary and not read out, regardless of what its
extension claimed.

**Delete is this feature's one write, and it is fenced accordingly.** `POST /api/jobs/delete` goes through the
origin-checked write CORS the chat routes use, not the read routes' `*` — a wildcard origin on a
destructive route would let any page open in the browser wipe the device's job history. Before
`rm -r` runs, `deleteJob` re-establishes the target from scratch: the id passes the same
`^[0-9A-Za-z][0-9A-Za-z._-]*$` check and direct-child test, an `lstat` refuses a **symlinked job
directory** outright (removing the link would leave the target; following it would delete outside
the root), and the realpath'd directory is confirmed to still be a direct child of the realpath'd
jobs root. A job whose state reads as `busy` is refused with a 409. Bad or missing id is a 400, a
directory that isn't there a 404.

## Acceptance criteria

- [x] `/jobs` lists every directory under `~/.claude/jobs` device-wide, newest activity first,
      with per-job file counts and byte totals.
- [x] A directory with no readable `state.json` is listed as a husk rather than hidden or erroring.
- [x] An unrecognised state word is `unknown` rather than being forced into a known tone.
- [x] `/jobs/$id` renders the directory as a folder tree with collapsible directories, opening on
      `state.json` when present.
- [x] `node_modules` and friends are listed but not descended into; symlinks are listed but not
      followed; the walk is bounded and reports when it stopped early.
- [x] Every file offers Pretty and Raw, with a per-kind pretty renderer for JSON, JSON Lines,
      markdown, logs, code, text and images, and a binary file reported instead of read.
- [x] A pretty log has its terminal escapes and carriage-return redraws resolved; the raw view
      keeps them (verified against a real 46 KB Storybook log: escapes present in raw, absent in
      pretty).
- [x] A `..` in the id or the file path, and a symlink pointing outside the job, are all refused
      with a 400 rather than read.
- [x] A row can delete its job directory, and the directory is actually gone from `~/.claude/jobs`
      afterwards — contents included.
- [x] The delete takes two clicks, states what it removed, and refreshes the listing from the same
      response.
- [x] A running job cannot be deleted (disabled in the UI, 409 from the API), and a symlinked job
      directory is refused rather than followed.
- [x] The delete route is POST-only under the origin-checked write CORS, not the read routes' `*`.
- [x] A half-written `state.json` or `timeline.jsonl` degrades to a husk / a skipped-line count
      instead of failing the page.
- [x] Core's job shaping, tree building and viewer transforms are unit-tested, the server's walk
      and path validation are tested against a real temp directory, and `pnpm typecheck`,
      `pnpm test` and `pnpm build` pass.
- [x] Each row joins its `sessionId` to the transcripts that session wrote and shows a
      **Liveness** verdict rolled up across the whole fan-out — one live branch makes the job
      live, and a job matching no transcript reads `unknown` rather than `finished`. A **Live**
      tile counts them, distinct from **Running**, which is still what the job says about
      itself (`server/test/sessions-liveness.test.ts`).

## Open questions

- The list walks every job directory on each load to count files and bytes. That is cheap today
  (eight jobs, `node_modules` never descended) but it is linear in what the jobs dirs hold, and
  nothing caches it. A device with hundreds of jobs would want the counts memoized on mtime.
- Neither page live-updates. A running job's `state.json` changes under you, and the sessions
  views already have SSE (`serveSse`) that this could reuse by watching the job directory. The
  Liveness column blunts the worst of it — a stale `working` no longer reads as proof the job
  is alive — but the row itself is still whatever the last load fetched.
- The job-to-transcript join is done, but on the *session* id rather than the thread id: a
  transcript records the session it belongs to, so a job's whole family — root and every
  subagent — comes back together, which is what the rolled-up liveness verdict wants. It does
  not identify *which* transcript is the job's own root, and a job whose session never reached
  the proxy still matches nothing.
- `jobFileKind` is an extension allow-list, so an unknown extension holding perfectly good text
  is assumed binary until the NUL check clears it — which it does, but only after the bytes are
  read. It errs toward showing something rather than nothing, but the mapping needs extending as
  new file types show up.
- The syntax tokenizer covers the four convention families the job directories actually contain.
  It is not a highlighter for any specific language and will under-colour anything exotic.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard these pages live in.
- [Project memory browser](project-memory-browser.md) — the sibling view over another corner of
  local `~/.claude` state, and the source of the Pretty/Raw pattern reused here.
- [Config inventory](config-inventory.md) — the other filesystem-rather-than-traffic pages.
- [Session transcripts](session-transcripts.md) — what the proxy records about the same runs from
  the traffic side.
