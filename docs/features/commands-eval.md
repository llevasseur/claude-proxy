---
type: feature
title: Commands eval
description: What each installed slash command costs to run — tokens attributed to its declared steps, where runs stop, and which waste patterns they trip.
tags: [dashboard, usage, commands, backend]
timestamp: 2026-08-02
---

# Commands eval

## Summary

Three [dashboard](admin-dashboard-for-claude-proxy-usage.md) pages over slash-command
invocations: **Commands** (`/commands`) ranks every installed command by what it costs,
**command detail** (`/commands/$command`) plots that command's runs, and **run detail**
(`/commands/$command/$threadId`) breaks one run down over the steps its command declares.
Capture is passive.

## Motivation

A command like `/task` or `/god` is a long, multi-step program, and its cost is invisible:
the [session transcript](session-transcripts.md) shows what happened but not which *step*
the tokens went to, and the per-session [suggestions](session-suggestions.md) engine is
step-blind by construction. This station charges spend to the `## Step N` headings the
command file itself declares, so an expensive step is attributable to the prose that
prescribed it.

## Behavior

- **A run is a session with a command envelope** — `parseCommandEnvelope`
  (`packages/core/src/commands.ts`) reads `<command-name>` off the opening prompt and
  returns `null` for an ordinary session. It records the command name without its slash,
  the verbatim `<command-args>`, the leading `--flag` tokens, and the criteria with the
  envelope and any injected `<system-reminder>` stripped. Only the *leading* run of flag
  tokens is parsed and nothing knows which flags take a value, so `--base main` records
  `base` and stops at `main`.
- **A locally-run command is not a run** — `/clear` and `/compact` execute in the CLI and
  never reach the model, but the CLI still sends their envelope as the first thing in the
  turn they opened, so a session begun with one used to root on it and be charged for
  everything typed after. The parser walks the envelopes in order and takes the first
  **non-local** one — the real command when there was one, no run at all when there wasn't
  — reading each envelope's `<command-args>` from its own block rather than the first in
  the prompt. That block ends at its own closing tag, not at the next envelope: criteria
  quote envelopes all the time, and cutting there empties the args. Locality is pure
  adjacency — the caveat has to sit directly ahead of the envelope — because that caveat
  text survives into compaction summaries far from any envelope it describes.
- **A record can be retracted** — the store only appends, so a thread that stops parsing as
  a run is rewritten with `retired: true` and dropped by `readCommandRuns`. Only a thread
  whose **opening prompt was read** is retired: a transcript that aged out, or one whose
  `.state.json` is missing or never captured a prompt, is absence of evidence rather than
  evidence the run never happened. Reconciliation carries retired records forward, so a
  thread that reads as a run again keeps the turns only the record still remembers.
- **The step catalogue comes from the installed file** — `parseCommandSteps` takes the
  `## Step N — Title` headings of `~/.claude/commands/<name>.md` (override the directory
  with `COMMANDS_DIR`, which exists for tests). Ordinals are kept as written, so `1.5`
  sorts between `1` and `2`; a repeated heading continues the same step rather than
  declaring a new one. A command with no `## Step N` headings yields an empty catalogue —
  a valid run with everything unattributed.
- **The catalogue is snapshotted per run**, with the file's `contentHash` (FNV-1a, 16 hex
  chars, not cryptographic), so a run stays interpretable after `/sync` rewrites the file
  and a hash change marks a before/after on the timeline.
- **Attribution is a heuristic and says so** — `attributeSteps` anchors turns from the
  agent's own narration and from the artifacts each step's body prescribes, then fills
  forward. `StepConfidence` ranks the anchor: `explicit` (a `STEP n/N` marker, or the step named within the first 48 characters
  of a line), `narrated` (the number appears mid-sentence, so it may be a reference),
  `boundary` (no number, but the node invokes something a single step names, e.g.
  `Skill(skill=clean)`), `inferred` (carried forward). Nodes before the first anchor stay
  in an explicit **unattributed** bucket the UI shows rather than hides.
- **Artifacts are mined from code spans** in each step's body — a `/name` sub-command
  (`skill`), a capitalized tool name (`tool`), or a shell line cut at its first flag or
  placeholder (`shell`). Tools every step can use (`Read`, `Bash`, `Agent`, …) are
  excluded as ambient, and the **longest** matching artifact wins. A tie across two steps
  anchors nothing.
- **Outcome** — `classifyOutcome` returns `completed` only on the strict reading: the last
  declared step was attributed *and* a `- done:` landed. Otherwise it falls to
  `interrupted` (the interruption kind the transcript already records), then `running`
  (the transcript is still being appended to), then `errored` (the last node was an error),
  then `interrupted` again as the default.
- **Waste counters, per step** (`countWaste`) — `erroredTools`, `duplicateReads` (every
  read of a path past the first), `retriedAfterError` (a call reissued with the same
  signature straight after it errored), `noOpTurns` (narration that produced no tool call),
  and `cacheMissTokens` (`realInput − cacheRead`, added by the caller from the turn series).
- **Pattern rules** (`detectPatterns`) — six deterministic rules badged on the node that
  tripped them: `repeat-read`, `retry-after-error`, `step-reentered`, `subagent-fanout`
  (at 3 spawns under one step), `context-respike` (a turn's `realInput` at least 1.5× the
  previous turn's, ignored below 20,000 tokens), and `step-errors-first`.
- **The store is the source, not the logs** — `server/src/command-runs.ts` distils each run
  into `logs/commands/runs.jsonl`, append-only and versioned (`COMMAND_RUN_SCHEMA`).
  Transcripts and captured bodies live for about a day, so a run is distilled while its raw
  material is still on disk and read back from the store afterwards. **There is no
  backfill** — data accrues going forward.
- **Commands page** (`/commands`) — four stat tiles (**Commands** installed, **With runs**,
  **Runs** in the store, **Spent** across every stored run) over a table ordered
  most-invoked first, with columns **Command**, **Steps**, **Runs**, **Reached the end**,
  **Tokens**, **Cost**, **Cost per run** (a sparkline, or *"needs two runs"*), and
  **Last run**. Rows are the installed files unioned with every command the store has
  history for, so a command `/sync` removed keeps its past under an **uninstalled** badge.
- **Command detail** (`/commands/$command`) — the command's runs as an outcome-coloured
  scatter (completed / interrupted / errored / running) with step-level stacked cost, and a
  `flags` facet narrowing to runs that used given flags.
- **Run detail** (`/commands/$command/$threadId`) — one run as a token-weighted tree over
  its declared steps, each carrying the confidence behind its placement, plus the
  unattributed bucket.
- **Endpoints** — `GET /api/commands`, `/api/commands/command?name=<name>[&flags=a,b]`, and
  `/api/commands/run?id=<id>`, each with a `/stream` SSE twin debounced at 600 ms. A
  missing `name` or `id` is `400`; an unknown one is `404`. Every read reconciles the store
  first, so it is current even on a cold server.

`packages/core/src/commands.ts` is pure — no I/O, no clock, no Node built-ins. The server
reads the files and captured requests and hands the pieces to it.

## Acceptance criteria

- [x] Every session whose opening prompt carries a `<command-name>` envelope is captured as
      a run, with no tagging and no harness.
- [x] A locally-run command is never a run, and never carries the cost of what followed it:
      a session opened by `/clear` is the run of whatever was typed after, or no run at all.
- [x] Steps come from the `## Step N` headings of the installed command file, snapshotted
      per run with the file's content hash.
- [x] A command with no declared steps is still a valid run, with everything unattributed.
- [x] Every attribution carries the confidence that produced it, and turns no anchor could
      place stay in a visible unattributed bucket.
- [x] `completed` requires both the last declared step and a `- done:`; everything else
      classifies as interrupted, errored, or running.
- [x] Runs are read from `logs/commands/runs.jsonl`, never from the day-old logs, and the
      store is reconciled before every API read.
- [x] `/commands`, `/commands/$command` and `/commands/$command/$threadId` each serve from
      an endpoint with an SSE twin, so a live run updates in place.

## Open questions

- **No `STEP n/N` marker is emitted yet.** `attributeSteps` matches it first and the
  narration rules stop mattering the day the commands write it, but today every anchor is
  heuristic.
- **Nested commands are double-counted by design** — a nested command counts both as a
  segment of its parent and toward its own command's numbers. Whether the Commands page
  totals should net that out is unsettled.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Session transcripts](session-transcripts.md)
- [Session suggestions](session-suggestions.md)
