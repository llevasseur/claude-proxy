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
sidecar per request. The Advice page carries a **Session suggestions** section that groups every
transcript into fixed windows of ten — sessions 1–10, 11–20, … — and lists, per window, what
would have reached the same outcome faster. Each window has a detail page with the full
suggestions, the sessions behind them, and the
[Request Breakdown](context-size-analytics.md) patterns that recur across those sessions'
largest captured requests.

## Motivation

The existing [advice](admin-dashboard-for-claude-proxy-usage.md) is computed from one day's
digest: token and cost aggregates, with no notion of what an agent *did*. The transcripts carry
that — the step sequence, the refusals, the errors — but a single session is too small a sample
to tell a habit from an accident. Ten is enough for a pattern to repeat and small enough that the
window still points at a specific stretch of work.

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
  - **Work ended without a recorded outcome** (*info*) — two populations with two terminal
    conditions, counted apart and reported apart in the evidence. A **top-level** thread owes each
    `## Task:` a `- done:` before the next one. A **subagent** owes a report to its caller instead,
    and structurally cannot write a `- done:`: that line comes from a turn carrying text and no
    tool call, which for a subagent is the reply to its last request — a reply no later request in
    that thread ever carries, so a subagent transcript always ends on its last tool call however
    cleanly it finished. The caller is the witness: a subagent counts as finished when the parent
    resumed at its `returnIndex`, and unfinished when it just stopped — the parent never resumed,
    the spawn came back as an `- ✗`, or the run was cut off at the spawn. Fires at 2+ across both
    populations; points at `/revive <thread id>`.
  - **Most calls were spent locating code, not changing it** (*info*) — 55%+ of a window's tool
    calls are discovery, over a floor of 20 calls.
  - **&lt;tool&gt; accounts for most failures** (*warn*, titled with the tool's own name) — a single
    tool owning 40%+ of a window's errors, over a floor of 3.
  - When nothing trips a threshold the window reports **"Nothing to trim in these sessions"** with
    its counts.
- **Sources** — every suggestion names the sessions it was counted in, strongest first, each with
  the number of steps that matched and one representative line quoted verbatim. Session names
  link to the transcript.
- **Bucket detail** (`/advice/sessions/$bucket`) — stat tiles (sessions, tasks + unfinished
  top-level tasks and adrift subagent threads, tool
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
  session may have a peak with no readable body — or, once its sidecars are gone, no peak at all.
  Those are skipped, counted in `meta.requestsMissing`, and reported next to the table; a window
  with none left says so instead of showing an empty table.

### Status flags

The suggestions themselves carry no state: a rule that keeps tripping keeps reappearing whether
or not anyone acted on it. A flag per suggestion records that someone did.

- **The flags** — `pending` (the default), `done` (applied), `skipped` (deliberately passed over),
  `dismissed` (the rule was wrong here). Each carries the ISO timestamp of the write and an optional
  note (a PR link, why it was skipped, why the rule misfired). `SUGGESTION_STATUSES` is the single
  source the rest derives from: the CLI's validation message joins it and the dashboard's control
  maps over it, so a new flag reaches both without a second edit.
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
    did not hold; the row names the bucket and date of the claim it broke.
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
  (restored to full contrast on hover/focus), and gives each one a `Pending / Done / Skipped`
  control. `Pending` is the undo: it clears the entry, the same write the API and CLI make. A write
  re-reads the status list rather than patching the row locally. A **hide resolved** toggle appears
  once anything is *settled* — acted on, or in a window the rule's own fix predates — and the Advice
  bucket list counts only unsettled suggestions as open. A recurrence badge sits next to the flag; a
  `regressed` suggestion is never dimmed and takes a coral border, and its control also names the
  bucket and date of the claim it broke when that claim was recorded in another bucket. Both pages
  show a `N regressed` badge in their header. The breakdown-derived suggestions carry no control:
  they are computed per request rather than per bucket, so the store has no row for them.
- **From the command line** — `pnpm --filter server suggestions list [-r <range>] [-s <flags>]
  [--recurrence <states>] [-d]` and `pnpm --filter server suggestions mark -r <bucket> -i <ids>
  -s <flag> [-n <note>]`, both with `--json` for the API's own shape. **Add pnpm's `--silent`
  before `--filter` whenever that JSON is going into a parser** — pnpm's script runner otherwise
  wraps the output in a `$ tsx …` echo and a `Scope: …` banner, on whichever stream that version
  of pnpm favours, and a pipe into `jq` fails on `Unexpected token 'S'`. `--silent` empties both
  streams of pnpm's own output and leaves the CLI's stdout, stderr and exit code untouched;
  `server/test/suggestions-cli-json.test.ts` drives that invocation and parses its stdout. The CLI
  reads the log directory directly, so it needs no running server. **`list` hides `historical` rows by default**,
  since a window that predates its rule's `done` can no longer be acted on — the count of what was
  hidden is printed, and `--recurrence historical` brings them back. Regressed rows are marked
  `⚠ REGRESSED since <date>` and totalled above the table.

### The judgement layer

The rules are deterministic pattern matches over transcripts. They have high recall and **no
judgment**, so some of what they report is simply wrong: `redundant-reads` collapses two long paths
that share a truncated prefix, and `serial-discovery` used to fire on reads that were genuinely
dependent — a misread the dismissals themselves eventually closed, by naming the reasoning recorded
between those reads as the evidence the rule was missing.
Before this layer nothing could record that a finding was *wrong* — `skipped` means the finding was
right and was deliberately passed over — so a wrongly-fired rule cost attention in every `/improve`
run forever. An agent now adjudicates a window before `/improve` acts on it.

- **`dismissed` vs `skipped`** — two different claims, and conflating them loses the only fact worth
  keeping. `skipped` says *the finding was right, and we chose not to act*; it may be worth
  revisiting. `dismissed` says *the rule was wrong here*; it never is. Only `done` is a dated claim,
  so **neither `skipped` nor `dismissed` can produce a recurrence state** — reading a regression off
  a dismissal would be reading a fix off a finding that never existed. The
  `historical`/`regressed`/`mixed` model is untouched by this layer, and a test pins that.
- **Store version 2** — a new top-level `judged` key beside `buckets`, mapping bucket index to
  `{ at, notes }`. A v1 file is migrated by defaulting `judged` to `{}`, which is the whole of that
  upgrade: every bucket in such a file reads as unjudged, which is true.
- **Why enrichment lives at bucket level, not on the suggestion.** The context a judge writes for a
  **confirmed** suggestion goes in `judged[bucket].notes[id]`, never on the suggestion's own entry.
  Two structural reasons, both load-bearing:
  - A confirmed suggestion is still `pending`, and **a pending entry cannot persist at all** — it is
    dropped on read and deleted on write. That is exactly what makes `Pending` the undo, and it is
    unchanged by this work.
  - The entry's single `note` is **overwritten** by whoever later marks the suggestion
    `done -n "<PR url>"`, so anything filed there is clobbered by the act of fixing it.

  Bucket-level storage keeps `note` single-purpose and the judge's context unclobberable. A
  **dismissed** suggestion needs no such treatment: it is an ordinary status write, with the reason
  in `note`, shown by the existing control and undone by `Pending` exactly as before.
- **Three bucket states**, exposed as `complete` on the bucket type:
  - `not-ready` — a partial window, short of `SESSION_BUCKET_SIZE`. It will gain sessions and its
    rules will re-fire over a wider window, so there is nothing stable to judge. Never judged, never
    improved upon.
  - `dirty` — complete, with no `judged[n]` entry. Work to do.
  - `clean` — complete, with one on record.

  **Cleanliness is per-bucket and is deliberately *not* derived from the suggestion entries.** If it
  were, un-dismissing a suggestion — the existing `Pending` undo, which *deletes* the entry — would
  re-dirty the bucket, the judge would run again, and it would re-dismiss the thing that was just
  un-dismissed. Keeping the flag at bucket level breaks that loop: a human override survives,
  because the judge never revisits a clean bucket.
- **The bucket-index guard** — judging is refused outright if **any** session in the corpus has a
  null `started`, naming the sessions at fault. Membership is ordered by
  `(a.started ?? '').localeCompare(b.started ?? '')`, so a null sorts ahead of every real timestamp,
  lands at the front of bucket 1, and shifts every boundary after it by one — silently re-pointing
  every stored verdict at sessions it never examined. Currently 0 sessions are affected; the guard
  exists to keep it that way. Bucket indexes are otherwise stable because **transcripts are never
  archived or evicted**: `retention.ts` only moves files whose *name* carries a date prefix, which is
  what keeps `sessions/`, `commands/`, `.chat/`, `suggestion-status.json` and the database out of it.
  The corpus is append-only, so a full bucket's membership is immutable.
- **Rule-level defects** — `ruleDefects` reports a rule dismissed in **3+ buckets** *and* in **50%+
  of the buckets it fired in**, with the count, the ratio and each bucket's dismissal reason. Both
  numbers live in `SUGGESTION_DEFECT_THRESHOLDS`. Both conditions are needed: the count alone would
  indict a rule that fired forty times and was wrong three, the ratio alone one that fired once. Only
  complete buckets count on either side, since a partial window can never contribute a dismissal and
  would only dilute the ratio. This is the point of accumulating dismissals at all — repeated noise
  about one rule is evidence the **rule** needs fixing, not a chore to redo every ten sessions.
- **Judging is one atomic write** — the dismissals and the `judged` record go through a single
  temp-file-plus-rename. Two writes could leave a bucket recorded as judged with its dismissals
  missing, or dismissed suggestions in a bucket the judge would adjudicate again.
- **From the command line** — `suggestions buckets [--dirty]` lists buckets with their
  complete/judged/dirty state; `suggestions judge -r <bucket> [--confirm <id>[:<note>],…]
  [--dismiss <id>:<reason>,…]` records one verdict; `suggestions judge --amnesty` marks every
  complete **still-unjudged** bucket judged with no notes, for drawing a line under a backlog rather
  than judging it all — it leaves already-judged buckets and their notes alone, so it can never
  delete enrichment; `suggestions defects` prints the rule-defect report. All read the log directory
  directly, so no server is required, and all take `--json`. A `--dismiss` without a reason is
  refused, as is judging an incomplete bucket. **A comma inside a reason stays part of that reason**:
  a value containing a colon splits only at a comma that introduces a new `<id>:` entry, and
  repeating the flag is the escape hatch for anything that cannot see.
- **Over HTTP** — status rows carry `bucketState`, `judgedAt` and any `enrichment`; `meta.bucketStates`
  counts dirty/clean/not-ready over **every** bucket rather than the rows returned, since how much of
  the corpus is unadjudicated is a fact about the corpus and not about the slice asked for. A `POST`
  carrying `judged` or `amnesty` takes the guarded judge path, through the same origin-checked CORS
  the existing writes use.
- **In the dashboard** — `dismissed` reaches the flag control automatically and takes the faintest
  tone of the four, since the row is a record rather than a finding; a dismissed suggestion is dimmed
  further than a merely resolved one with its reason still legible, and is **not counted as open**.
  Every bucket is badged **Judged / Unjudged / Not yet full** on both the Advice list and the bucket
  detail, the Advice header carries an `N unjudged` badge, and a confirmed suggestion shows the
  judge's enrichment note under its control.

The data path is `logs/sessions/*.md` + `.audit.json` sidecars — read through the
`SidecarSource` seam, so the server answers from the SQLite substrate by default and from the
file scan under `DB_READS=0`, while the CLI always scans the files —
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
- [x] A fourth flag `dismissed` records that the rule was **wrong** in a window, distinct from
      `skipped`, and produces no recurrence claim — asserted by a test.
- [x] The store is version 2 with a top-level `judged` map, and a v1 file migrates by defaulting it
      to `{}` without losing a flag.
- [x] Enrichment for a confirmed suggestion is stored at bucket level, so the pending-entry
      invariant holds and marking the suggestion `done` cannot clobber the judge's context.
- [x] Buckets expose completeness and read as `not-ready` / `dirty` / `clean`, with cleanliness held
      per bucket so un-dismissing a suggestion cannot re-dirty its window.
- [x] Judging is refused when any session carries a null `started`, naming the session at fault.
- [x] A rule dismissed in 3+ buckets and 50%+ of those it fired in is reported as a rule defect, with
      both numbers in an exported tunable.
- [x] `suggestions buckets`, `judge` (with `--amnesty`) and `defects` work with no server running,
      and a judge writes its dismissals and its verdict in one atomic write.
- [x] The dashboard badges every bucket's judged state, shows the judge's enrichment on a confirmed
      suggestion, and dims a dismissed one without counting it as open.

## Open questions

- Windows are fixed at ten by position, so a window never re-scopes as new sessions arrive. That
  keeps bucket 1 stable and comparable over time, but it means a habit that spans a window
  boundary is split across two pages. Worth also offering a rolling last-10 view?
- ~~`redundantReads` matches on the truncated `Read(file_path=…)` signature~~ — **resolved.**
  "Could collapse into one" was already happening: a judge verdict on bucket 42 found the rule
  firing on sessions with no duplicate reads at all, because every `Read` under a
  `.claude/worktrees/<long-branch>/…` path renders to the same 60 characters. The proxy now
  writes `argsHash` — `sha256(name + "\n" + key-sorted JSON of the whole input)`, first 16 hex —
  into the `.nodes.jsonl` row beside the display text, `SessionNode.argsHash` carries it through
  both the file and SQLite sources, and the rule keys on `node.argsHash ?? node.tool`. The
  fallback is the legacy path, kept deliberately: a transcript written before the field has no
  hashes and reads exactly as it did before. **It is also dated**, as `suggestions-args-hash-key`
  in `packages/core/src/fallbacks.ts` (2026-08-07), so `server/test/fallback-retirement.test.ts`
  says when it stops being reachable rather than leaving "kept deliberately" to quietly mean
  "kept forever" — this fallback is the *wrong* key rather than merely an older one, so deleting
  it the day no retained transcript needs it is worth doing. It is still reachable today: the
  archive's floor is 2026-07-12. The rules still read distilled lines for everything
  else, so any *other* rule that wants to compare arguments has the same key available and does
  not yet use it.
- Severity is fixed per rule rather than scaled by how badly a threshold was crossed. A window
  with 2 refusals and one with 40 both read *high*.
- The breakdown roll-up uses each session's peak request only. That is the cheapest honest
  sample, but a tool schema dropped midway through a session is invisible to it.
- ~~Judging is a write an agent makes; nothing checks that it actually read the window.~~ **Closed
  by the provenance envelope.** `judge --thread <id>` records the judging session's own thread id on
  the verdict, and with it how many of the window's ten transcripts that thread opened. The count is
  *derived*, not self-reported: the judging run is itself a session the proxy transcribes, so its
  tool calls are read back off `logs/sessions/<threadId>.md` and matched against the window's thread
  ids. Any tool naming a transcript counts — a `Bash` grep opened it as much as a `Read` did — and
  the judge's own transcript never counts toward its own window. Under 30% the verdict is marked a
  **thin pass**, on the Advice page and in `suggestions buckets`. It is advisory in both: a thin
  pass is never refused, never hidden, and a verdict with no envelope is not marked at all, since
  every verdict written before this existed has none. The threshold is a judgement call with no data
  behind it yet, set low deliberately — the marker catches a pass that read *almost nothing* rather
  than prescribing how much reading a careful verdict takes.
  - Still open on this thread: the envelope records the *judge*, not the human who reviewed it, and
    a judge that opens every transcript without reading them counts as thorough. The count is a
    floor on effort, not a measure of attention.
- A rule defect is reported but nothing links it back to the rule's own thresholds. The obvious next
  step is for the report to name the `SUGGESTION_THRESHOLDS` entry a defective rule is governed by,
  so the fix has somewhere to start.
- The dashboard shows the judgement layer but cannot write to it: `dismissed` is settable from the
  flag control, yet a bucket can only be *judged* from the CLI or the API. That is deliberate for now
  — a verdict is an agent's product — but it means a human who disagrees can un-dismiss a suggestion
  without being able to re-judge the window.
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
