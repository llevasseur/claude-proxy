---
type: feature
title: Session suggestions
description: Every ten transcripts are scored for ways to reach the same outcome in fewer steps, with less context, and against fewer guardrails — with each claim traceable to the sessions it was counted in.
tags: [dashboard, usage, advice]
timestamp: 2026-07-25
---

# Session suggestions

## Summary

The proxy already writes one [transcript](session-transcripts.md) per conversation thread and
one audit sidecar per request. Read across a run of sessions rather than one at a time, those
records answer a question no single session can: *what does this agent keep doing the slow way?*
The Advice page now carries a **Session suggestions** section that groups every transcript into
fixed windows of ten — sessions 1–10, 11–20, … — and lists, per window, what would have reached
the same outcome faster. Each window has a detail page with the full suggestions, the sessions
behind them, and the [Request Breakdown](context-size-analytics.md) patterns that recur across
those sessions' largest captured requests.

## Motivation

The existing [advice](admin-dashboard-for-claude-proxy-usage.md) is computed from one day's
digest: token and cost aggregates, with no notion of what an agent *did*. The transcripts carry
that — the step sequence, the refusals, the errors — but reading them one by one is exactly the
work the dashboard exists to avoid, and a single session is too small a sample to tell a habit
from an accident. Ten is enough for a pattern to repeat and small enough that the window still
points at a specific stretch of work.

The improvements worth finding are the ones that cost nothing to adopt: a guardrail that refuses
a call the agent had already decided to make (a turn spent, then retried), an error rediscovered
in session after session because nothing wrote the answer down, four independent reads issued
one at a time instead of together, a tool schema shipped on every request that these sessions
never called.

## Behavior

- **Bucketing** — sessions are ordered oldest-first (by `started`, ties by thread id) and split
  into windows of `SESSION_BUCKET_SIZE` (**10**). Bucket 1 always covers the same ten transcripts
  as new ones arrive; the last bucket keeps the remainder and narrows its label (`"21–23"`)
  rather than claiming a full ten. The list shows the newest bucket first.
- **Backfill on load** — the whole history is recomputed from every transcript on each request to
  `GET /api/sessions/suggestions`. There is no incremental state, so a first load and a refresh
  do identical work and a window that gains its tenth session simply appears on the next fetch.
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
    `ls`/`git status`) with no decision or error between them, which makes them independent by
    construction.
  - **Files were re-read inside one session** (*info*) — the same `Read` signature 3+ times.
  - **Tasks are taking a lot of steps** (*warn*) — above 25 tool calls per task across the window.
  - **Tasks ended without a recorded outcome** (*info*) — a `## Task:` with no `- done:` before
    the next one, at 2+ per window; points at `/revive <thread id>`.
  - **Most calls were spent locating code, not changing it** (*info*) — 55%+ of a window's tool
    calls are discovery, over a floor of 20 calls.
  - **One tool accounts for most failures** (*warn*) — a single tool owning 40%+ of a window's
    errors, over a floor of 3.
  - When nothing trips a threshold the window reports **"Nothing to trim in these sessions"** with
    its counts, so an empty result is still evidence.
- **Sources** — every suggestion names the sessions it was counted in, strongest first, each with
  the number of steps that matched and one representative line quoted verbatim. Session names
  link to the transcript, so every claim on the page is checkable against its source.
- **Bucket detail** (`/advice/sessions/$bucket`) — stat tiles (sessions, tasks + unfinished, tool
  calls + per-task, errors + discovery share), the window's suggestions, the breakdown-derived
  suggestions, the **Request breakdown patterns** table, and the sessions in the window.
- **Request Breakdown patterns** — each session in the window contributes its **largest** captured
  request (its peak, matched on the transcript's session id, the same join the Peak context tile
  uses), so the roll-up compares like with like and reads at most ten request bodies. The table
  ranks the system prompt, the conversation, and each tool schema by mean bytes, showing how many
  of the window's peak requests carried each and its mean share. A region carried by *all* of them
  is a fixed cost on every turn those sessions took.
- **Breakdown suggestions** — two claims the transcripts cannot support on their own: tool schemas
  reaching 40%+ of the average request, and a single tool schema present in **every** peak request
  at 12%+ of it. Their sources are the captured requests the numbers were measured from.
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
  stops tripping, and a rule that starts tripping again in the same window is *not* re-flagged.
- **Where they live** — `<logDir>/suggestion-status.json`, beside the transcripts they describe, so
  they travel with a `LOG_DIR` override and stay device-local (`logs/` is gitignored). Only
  decisions are written: setting a suggestion back to `pending` deletes its entry, so an empty file
  and a missing one both mean "nothing done yet". Writes go through a temp file and a rename, and a
  corrupt file reads as empty rather than taking the page down with it.
- **The lean list** — `GET /api/sessions/suggestions/status[?range=&status=]` returns one row per
  suggestion (`bucket`, `label`, `id`, `severity`, `title`, `status`, and `updated`/`note` once
  set), oldest bucket first. `range` accepts one bucket (`9`), a list (`2,3,9`), a span (`2-9`) or
  a mix; `status` accepts a comma-separated subset of the flags. This is the list an agent reads to
  find what is still pending in a range without pulling each bucket's full drill-down. A malformed
  range is a 400.
- **Opt-in detail** — `&detail=1` adds each suggestion's `detail`, `evidence` and `sources` to the
  rows. Scanning a wide range stays lean by default; a caller about to act on what it found gets the
  whole claim in the same call rather than one drill-down request per bucket.
- **Recording** — `POST /api/sessions/suggestions/status` with `{ "updates": [{ bucket, id, status,
  note? }] }`. It goes through the same origin-checked CORS the chat routes use, since it writes.
  An update naming a suggestion no rule currently produces is still written and reported under
  `meta.unknown`, so a typo is visible rather than silent.
- **From the command line** — `pnpm --filter server suggestions list [-r <range>] [-s <flags>] [-d]` and
  `pnpm --filter server suggestions mark -r <bucket> -i <ids> -s <flag> [-n <note>]`, both with
  `--json` for the API's own shape. The CLI reads the log directory directly, so it needs no
  running server.

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
- [x] The flag store is unit-tested pure (`packages/core/test/suggestion-status.test.ts`) and its
      file handling is tested in `server/test/suggestion-status.test.ts`.

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
- The status flags have no UI yet — they are written by the API and the CLI, and the Advice pages
  still render every suggestion the same whether or not it is flagged. A badge on the bucket detail
  (and a "hide done" toggle) is the obvious next step.
- A flag's write is read-modify-write on one JSON file, so two writers racing lose one flag. One
  dashboard and one agent at a time is the actual usage; a lock would be cheap if that changes.

## Related

- [Session transcripts](session-transcripts.md)
- [Context-size analytics](context-size-analytics.md)
- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Live session graph](live-session-graph.md)
