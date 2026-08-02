---
type: feature
title: Session suggestions
description: Every ten transcripts are scored for ways to reach the same outcome in fewer steps, with less context, and against fewer guardrails — with each claim traceable to the sessions it was counted in.
tags: [dashboard, usage, advice]
timestamp: 2026-07-25
---

# Session suggestions

## Summary

The proxy writes one [transcript](session-transcripts.md) per conversation thread and one audit
sidecar per request. Read across a run of sessions, those records answer what no single session
can: *what does this agent keep doing the slow way?* The Advice page carries a **Session
suggestions** section that groups every transcript into fixed windows of ten — sessions 1–10,
11–20, … — and lists, per window, what would have reached the same outcome faster. Each window
has a detail page with the full suggestions, the sessions behind them, and the
[Request Breakdown](context-size-analytics.md) patterns that recur across those sessions'
largest captured requests.

## Motivation

The existing [advice](admin-dashboard-for-claude-proxy-usage.md) is computed from one day's
digest: token and cost aggregates, with no notion of what an agent *did*. The transcripts carry
that — the step sequence, the refusals, the errors — but reading them one by one is the work the
dashboard exists to avoid, and a single session is too small a sample to tell a habit from an
accident. Ten is enough for a pattern to repeat and small enough that the window still points at
a specific stretch of work.

## Behavior

- **Bucketing** — sessions are ordered oldest-first (by `started`, ties by thread id) and split
  into windows of `SESSION_BUCKET_SIZE` (**10**). Bucket 1 always covers the same ten transcripts
  as new ones arrive; the last bucket keeps the remainder and narrows its label (`"21–23"`)
  rather than claiming a full ten. The list shows the newest bucket first.
- **Backfill on load** — the whole history is recomputed from every transcript on each request to
  `GET /api/sessions/suggestions`. There is no incremental state, so a window that gains its
  tenth session appears on the next fetch.
- **Transcript rules** — eight independent rules, each returning one suggestion or nothing, with
  the thresholds collected in `SUGGESTION_THRESHOLDS`:
  - **Guardrails refused calls these sessions needed** (*high*) — `- ✗` lines whose text reads as
    a refusal (blocked / permission / denied / not allowed / …) rather than a failure, at 2+ per
    window.
  - **The same error keeps being rediscovered** (*warn*) — errors normalized (paths, numbers and
    quoted fragments blanked) so the same problem with different arguments collapses to one
    signature, reported when a signature recurs.
  - **Read-only calls went out one at a time** (*warn*) — runs of 4+ consecutive discovery calls
    (`Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch`, or a `Bash` running an inspecting verb like
    `ls`/`git status`) with no decision or error between them.
  - **Files were re-read inside one session** (*info*) — the same `Read` signature 3+ times.
  - **Tasks are taking a lot of steps** (*warn*) — 25 or more tool calls per task across the window.
  - **Tasks ended without a recorded outcome** (*info*) — a `## Task:` with no `- done:` before
    the next one, at 2+ per window; points at `/revive <thread id>`.
  - **Most calls were spent locating code, not changing it** (*info*) — 55%+ of a window's tool
    calls are discovery, over a floor of 20 calls.
  - **&lt;tool&gt; accounts for most failures** (*warn*, titled with the tool's own name) — a single
    tool owning 40%+ of a window's errors, over a floor of 3.
  - When nothing trips a threshold the window reports **"Nothing to trim in these sessions"** with
    its counts.
- **Sources** — every suggestion names the sessions it was counted in, strongest first, each with
  the number of steps that matched and one representative line quoted verbatim. Session names
  link to the transcript.
- **Bucket detail** (`/advice/sessions/$bucket`) — stat tiles (sessions, tasks + unfinished, tool
  calls + per-task, errors + discovery share), the window's suggestions, the breakdown-derived
  suggestions, the **Request breakdown patterns** table, and the sessions in the window.
- **Request Breakdown patterns** — each session in the window contributes its **largest** captured
  request (its peak, matched on the transcript's session id, the same join the Peak context tile
  uses), so the roll-up reads at most ten request bodies. The table ranks the system prompt, the
  conversation, and each tool schema by mean bytes, showing how many of the window's peak requests
  carried each and its mean share.
- **Breakdown suggestions** — two claims the transcripts cannot support on their own: tool schemas
  reaching 40%+ of the average request, and a single tool schema present in **every** peak request
  at 12%+ of it. The single-schema claim names the captured requests it was measured from; the
  whole-schema one is measured over the window's averages and names none.
- **Missing bodies** — raw `.request.txt` captures age out of the log before the sidecars do, so a
  session may have a peak with no readable body. Those are skipped, counted in
  `meta.requestsMissing`, and reported next to the table; a window with none left says so instead
  of showing an empty table.

### Status flags

The suggestions themselves carry no state — a rule that keeps tripping keeps reappearing whether
or not anyone acted on it. A flag per suggestion records that someone did:

- **The flags** — `pending` (the default), `done` (applied), `skipped` (deliberately passed over).
  Each carries the ISO timestamp of the write and an optional note (a PR link, why it was skipped).
- **The key is `(bucket index, suggestion id)`.** Both halves are stable — buckets are fixed
  windows numbered oldest-first, and a suggestion's id is its rule's id — so a flag survives the
  recomputation that happens on every load. Marking a suggestion `done` sticks even after the rule
  stops tripping.
- **A `done` is read as a dated claim.** A window is frozen, so a rule that tripped on sessions
  recorded last week trips on them forever — "still tripping" is not evidence that a fix failed.
  Each flag's `updated` timestamp is compared against the window's own session span, and every
  window gets a **recurrence** state:
  - `historical` — every session in the window predates the claim. Expected to keep tripping;
    nothing left to act on.
  - `regressed` — every session started *after* the claim and the rule tripped anyway. The change
    did not hold. This is the signal, and the row names the bucket and date of the claim it broke.
  - `mixed` — the window straddles the claim, so its evidence is part pre-fix and proves nothing.
  - `none` — no dated `done` for that rule, or the dates needed to compare are missing.

  The claim is **rule-wide, not per window**: `ruleResolutions` keeps the most recent `done` for
  each suggestion id, whichever bucket recorded it, so one mark carries forward to every window
  recorded afterwards instead of needing one mark per bucket. Only `done` counts — `skipped`
  never produces a `regressed`. An undated flag is ignored rather than used to invent a regression.
- **Where they live** — `<logDir>/suggestion-status.json`, beside the transcripts they describe, so
  they travel with a `LOG_DIR` override and stay device-local (`logs/` is gitignored). Only
  decisions are written: setting a suggestion back to `pending` deletes its entry, so an empty file
  and a missing one both mean "nothing done yet". Writes go through a temp file and a rename, and a
  corrupt file reads as empty rather than taking the page down with it.
- **The lean list** — `GET /api/sessions/suggestions/status[?range=&status=&recurrence=]` returns
  one row per suggestion (`bucket`, `label`, `id`, `severity`, `title`, `status`, `recurrence`, and
  `updated`/`note`/`resolved` once set), oldest bucket first. `range` accepts one bucket (`9`), a
  list (`2,3,9`), a span (`2-9`) or a mix; `status` accepts a comma-separated subset of the flags;
  `recurrence` a comma-separated subset of the four states. `meta.counts` totals the flags and
  `meta.recurrences` the states, both over the rows returned. A malformed range, flag or state is
  a 400.
- **Opt-in detail** — `&detail=1` adds each suggestion's `detail`, `evidence` and `sources` to the
  rows; scanning a wide range stays lean by default.
- **Recording** — `POST /api/sessions/suggestions/status` with `{ "updates": [{ bucket, id, status,
  note? }] }`. It goes through the same origin-checked CORS the chat routes use, since it writes.
  An update naming a suggestion no rule currently produces is still written and reported under
  `meta.unknown`, so a typo is visible rather than silent.
- **In the dashboard** — the bucket detail badges every flagged suggestion, dims the ones acted on
  (restored to full contrast on hover/focus, so nothing becomes unreadable), and gives each one a
  `Pending / Done / Skipped` control. `Pending` is the undo: it clears the entry, the same write the
  API and CLI make. A write re-reads the status list rather than patching the row locally. A
  **hide resolved** toggle appears once anything is *settled* — acted on, or in a window the rule's
  own fix predates — and the Advice bucket list counts only unsettled suggestions as open. A
  recurrence badge sits next to the flag, and a `regressed` suggestion is never dimmed and takes a
  coral border; a regressed control also names the bucket and date of the claim it broke when that
  claim was recorded in another bucket. Both pages show a `N regressed` badge in their header. The
  breakdown-derived suggestions carry no control —
  they are computed per request rather than per bucket, so the store has no row for them.
- **From the command line** — `pnpm --filter server suggestions list [-r <range>] [-s <flags>]
  [--recurrence <states>] [-d]` and `pnpm --filter server suggestions mark -r <bucket> -i <ids>
  -s <flag> [-n <note>]`, both with `--json` for the API's own shape. The CLI reads the log
  directory directly, so it needs no running server. **`list` hides `historical` rows by default**,
  since a window that predates its rule's `done` can no longer be acted on — the count of what was
  hidden is printed, and `--recurrence historical` brings them back. Regressed rows are marked
  `⚠ REGRESSED since <date>` and totalled above the table.

The data path is `logs/sessions/*.md` + `.audit.json` sidecars →
`packages/core/src/suggestions.ts` (pure: `sessionSuggestionBuckets`, `suggestBucket`,
`summarizeBreakdownPatterns`, `suggestFromBreakdown` — no I/O, no clock) → `server`
(`buildSessionSuggestions` / `buildSessionSuggestionBucket` behind
`GET /api/sessions/suggestions` and `/api/sessions/suggestions/bucket?index=`) → `apps/admin`
(`/advice` section and `/advice/sessions/$bucket`). A bucket index that names no window is a
404; a non-integer or sub-1 index is a 400.

## Acceptance criteria

- [x] The Advice page lists session suggestions in fixed windows of ten (1–10, 11–20, …), newest
      window first, with the whole history recomputed on each load.
- [x] Each window shows its suggestions, its time span, and its task/tool/error counts, and links
      to a detail page.
- [x] The detail page shows the window's suggestions, each naming the sessions it was counted in
      with a quoted sample, plus the sessions in the window.
- [x] The detail page shows the Request Breakdown patterns that recur across those sessions'
      largest captured requests, and the suggestions those patterns support.
- [x] Rules cover blocked guardrails, repeated errors, serial discovery, redundant reads, step
      count per task, unfinished tasks, discovery share, and error-prone tools.
- [x] The suggestion engine is pure and unit-tested in `packages/core/test/suggestions.test.ts`.
- [x] A window whose captured request bodies have aged out still renders, reporting how many
      sessions had no readable request.
- [x] Every suggestion carries a status flag — `pending` by default, settable to `done` or
      `skipped` with an optional note — keyed so it survives the recomputation on every load.
- [x] The flags are listable as a lean row per suggestion, filterable by bucket range and by flag,
      over HTTP and from the command line without a running server.
- [x] The Advice pages show each suggestion's flag and let one be marked `done`/`skipped` or set
      back to `pending` inline, without a full reload, with resolved suggestions de-emphasized and
      hideable but still reachable.
- [x] The flag store is unit-tested pure (`packages/core/test/suggestion-status.test.ts`) and its
      file handling is tested in `server/test/suggestion-status.test.ts`.
- [x] A `done` is dated, and one mark carries to every window recorded after it, so a window whose
      sessions predate the fix reads as `historical` rather than as unaddressed work.
- [x] A rule that trips in a window recorded entirely *after* its own `done` reads as `regressed`,
      naming the bucket and date of the claim, so a fix that did not hold cannot be mistaken for a
      new finding.
- [x] `historical` rows are excluded from the CLI's default `list`, with the hidden count reported
      and reachable via `--recurrence`.

## Open questions

- Windows are fixed at ten by position, so a window never re-scopes as new sessions arrive. That
  keeps bucket 1 stable and comparable over time, but it means a habit that spans a window
  boundary is split across two pages. Worth also offering a rolling last-10 view?
- The rules read the transcript's *distilled* lines, so a tool call's arguments are truncated at
  capture. `redundantReads` therefore matches on the truncated `Read(file_path=…)` signature —
  two long paths sharing a prefix could collapse into one. Worth having the proxy record a hash
  of the full argument?
- Severity is fixed per rule rather than scaled by how badly a threshold was crossed. A window
  with 2 refusals and one with 40 both read *high*.
- The breakdown roll-up uses each session's peak request only. That is the cheapest honest
  sample, but a tool schema dropped midway through a session is invisible to it.
- The dashboard marks a flag but cannot attach a note — the API and CLI can, and the UI displays
  whatever they wrote. A `skipped` without a reason is the flag that most wants one; a note field on
  the control is the obvious next step.
- The Advice page fetches the suggestions and their flags as two calls, each recomputing every
  bucket server-side. Correct, and cheap enough at this history size, but the join could move into
  `GET /api/sessions/suggestions` if that stops being true.
- A flag's write is read-modify-write on one JSON file, so two writers racing lose one flag. One
  dashboard and one agent at a time is the actual usage; a lock would be cheap if that changes.
- The recurrence date is when someone *marked* the suggestion, not when the change actually landed.
  Marking right after the PR returns keeps the two within minutes of each other, but a flag set a
  week late reads the sessions in between as `historical` when they were really post-fix. A
  `landed` timestamp on the entry, separate from `updated`, would decouple them.
- `regressed` needs the window to sit *entirely* after the claim, so the first window to span a fix
  reports `mixed` and a genuine regression inside it waits for the next full window of ten. That is
  the conservative direction — it never cries regression on pre-fix evidence — but it does delay the
  signal by up to ten sessions.

## Related

- [Session transcripts](session-transcripts.md)
- [Context-size analytics](context-size-analytics.md)
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Live session graph](live-session-graph.md)
