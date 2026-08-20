---
type: feature
title: Device system prompt
description: A page over ~/.claude/CLAUDE.md that reads the device-wide instructions every session loads, sizes them in bytes and tokens, and edits the file in place with a backup and an atomic write.
tags: [dashboard, device, editing, architecture]
timestamp: 2026-08-02
---

# Device system prompt

## Summary

A page in the [admin dashboard](admin-dashboard-for-claude-proxy-usage.md) over
`~/.claude/CLAUDE.md` — the device-wide instructions Claude Code prepends to the system prompt of
**every** session on this machine, in every project. **System prompt** (`/system-prompt`) shows the
file with its size in bytes, an estimate of the tokens it costs per request, its line count and its
heading outline, and — unlike every other view over local state — lets you **edit and save it**.

Like the [background jobs browser](background-jobs-browser.md), the
[config inventory](config-inventory.md) and the
[project memory browser](project-memory-browser.md), this reads the local filesystem rather than
captured traffic. Unlike all of them, it writes back.

## Motivation

This file is loaded into every session, so every byte in it is paid for on every request — and
nothing in the dashboard showed it. The proxy never records it either: it arrives inside the
system prompt, which the [context-size analytics](context-size-analytics.md) count in aggregate
but do not break down.

Two things follow from that:

- **Reading it is only half the job.** The reason to look at device instructions is almost always
  to change them, so a read-only view would send you to an editor and then back here.
- **It is authored state with no version control behind it.** `~/.claude` is not a git repo. An
  overwrite that goes wrong loses text a human wrote and cannot reconstruct, which is a different
  risk from the dashboard's other write ([deleting a job](background-jobs-browser.md), which
  removes machine-generated scratch). The write path is built accordingly.

The token estimate is the point of the size tiles: at the repo's measured 2.78 bytes per token a
12 KB instruction file is roughly 4400 tokens on every request of every session.

## Behavior

- **System prompt** (`/system-prompt`) — **Size / Est. tokens / Lines / Modified** tiles over an
  editor holding the file's text. Size reads `N on disk` underneath while there are unsaved
  changes, so the tile states both numbers rather than silently meaning one of them. Lines carries
  the section count from the outline. Est. tokens is labelled *per request*.
- **The stats are live on the draft, not the file.** Every keystroke re-measures bytes, re-derives
  the outline and re-estimates tokens from the text in the editor, using the same core functions
  the server uses on save. They measure the draft as typed, not the normalized form that lands, so
  a draft with trailing blank lines or CRLF reads a few bytes above what the save writes.
- **Edit / Preview** — a segmented toggle between the editor and the file rendered as markdown
  through the dashboard's `Markdown` renderer.
- **Saving** — `Save` is enabled only while the draft differs from disk; `Revert` restores the
  file's text. `⌘S` / `Ctrl-S` saves from the editor. The response carries a fresh read of the
  file, which seeds the query cache directly, so the page shows what is *on disk* after a save
  rather than what it hoped it wrote.
- **Save is a confirm step, not a button.** `Save` re-reads the file and swaps the editor for a
  **line diff of the draft against the bytes on disk right now** — not the bytes the page loaded
  with, which on a tab left open for hours is the wrong comparison. The diff renders through the
  dashboard's own `CodeBlock`, so it inherits the shared code styling and needs no diff
  dependency; additions and removals are tinted per line and each region opens with a
  `@@ -old +new @@` header. `Back to the editor` leaves the file untouched.
- **A concurrent edit shows up as that same diff.** The confirm-time read either still carries
  the mtime editing began from or it does not. When it does not — another editor, another agent —
  the step says so and the diff it is already showing is *against the new contents*, so the
  question "what would I have lost" is answered on screen rather than in a terminal. The write is
  refused until it is confirmed a second time, against a `Overwrite anyway` button in the danger
  styling.
- **Emptying the prompt is armed.** Saving an empty draft over a non-empty file takes a second
  click, because it discards authored text.
- **A file that does not exist yet** is not an error: the page opens on an empty editor and says
  saving will create it.
- **Too large is refused before it is written.** A draft past the 200 KB ceiling disables the save
  and says so; the server refuses it independently.

Data flows `~/.claude/CLAUDE.md` → `server` → `packages/core` → `apps/admin`, with core in the
middle for both directions. The shaping is pure and browser-safe (`TextEncoder`, not `Buffer`) —
`outlineSystemPrompt`, `summarizeSystemPrompt`, `normalizeSystemPromptText`,
`parseSystemPromptText`, `parseSystemPromptExpectedModified`, `diffSystemPromptText` and
`utf8Bytes` in `packages/core/src/system-prompt.ts`. File
I/O is `server/src/system-prompt.ts` (`resolveSystemPromptPath`, `readSystemPromptFile`,
`writeSystemPromptFile`). The path is `~/.claude/CLAUDE.md`, overridable with
`CLAUDE_SYSTEM_PROMPT` — which is also how the tests drive the write path without touching the
real file. The endpoint is `GET /api/system-prompt` (the file, its outline and the ceiling) and
`POST /api/system-prompt` (`{ text, expectedModified? }` → the same shape plus the backup path).

The diff is core's, not a library's. It trims the matching head and tail first — a long
instruction file usually changes in one place — and aligns only what is left with an LCS table,
so the common edit costs almost nothing. Past a cell ceiling it stops aligning and reports the
change as a whole-file replacement, which at that size is what it is.

`outlineSystemPrompt` skips fenced code blocks, so a `# comment` inside a shell example is not
mistaken for a section, and sizes each section from its heading to the next one or EOF in UTF-8
bytes — so the outline reports what each part of the file actually costs.

## Security

The write is the whole of the risk surface here, and it is fenced the same way the job delete is:

- `POST /api/system-prompt` is on the `WRITE_ROUTES` allowlist, so it goes through `servePost` and
  the **origin-checked** write CORS (`CHAT_ORIGINS`) rather than the read routes' `*`. A wildcard
  origin on this route would let any page open in the browser rewrite the instructions every
  future session loads. The GET stays under the open read CORS with its neighbours, and a POST to
  any route *not* on that allowlist is still a 405. It is the fourth write the local server
  allows, on the terms
  [ADR 0003](../adrs/0003-allow-narrowly-scoped-writes-in-the-local-server.md) set for the first.
- The body is **validated before the file is touched**: `parseSystemPromptText` rejects a
  non-string with `must be a string` and anything past `SYSTEM_PROMPT_MAX_BYTES` (200 KB) with
  `larger than`, both mapped to a 400, and the 1 MB body cap applies as it does to every write.
  Only those failures are 400s: a write that fails on the filesystem — no permission, no space —
  is a 500, so the editor is not sent looking for a typo in text that was fine.
- **An unreadable file is an error, not an empty one.** Only `ENOENT` reads as "no file yet";
  any other read failure propagates, because rendering it as absent would invite a save over a
  file the server never managed to read. A backup that fails for any reason other than there
  being no previous file stops the save for the same reason.
- No path arrives from the request. The file is resolved **once at server start** from the
  environment, so there is no id or filename to traverse with — unlike the jobs routes, this one
  cannot be pointed anywhere.

Overwriting authored text gets four safeguards beyond that:

- **Nothing is written blind.** The save is a confirm step over a diff, so the destructive part of
  the write is seen before it happens rather than reconstructed from a `.bak` afterwards.
- **A stale write is refused.** When the body carries `expectedModified` and the file's mtime no
  longer matches it, the save throws before `writeSystemPromptFile` is reached — a **409**, since
  the request was well-formed and the file simply moved under it. The browser always sends the
  mtime it just read at confirm time, so even a change made *while the diff was on screen* is
  caught. Omitting the field writes regardless, which is what a caller that never read the file
  wants; `null` means "there was no file", and is refused once one appears.
- **A `.bak` first.** Every save that finds an existing file copies it to `<path>.bak` before
  writing, so the previous contents survive a bad edit. The first save has nothing to back up and
  reports `backupPath: null`.
- **An atomic write.** The new text goes to `<path>.<pid>.tmp` and is then `rename`d into place, so
  an interrupted write cannot leave a half-file where the device instructions should be.

Text is normalized before it lands — CRLF to LF, trailing blank lines collapsed to exactly one
closing newline — so the file does not accumulate whitespace churn across saves. An emptied prompt
is written as an empty file rather than deleting it, keeping "no instructions" distinct from "the
file went missing".

`/api/system-prompt` is deliberately **outside the SQLite route registry**, alongside
`/api/projects`, `/api/jobs` and `/api/hooks-plugins`: those routes read `~/.claude/...`, and the
substrate is a materialized view of `logs/` (see
[ADR 0004](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)).
There is nothing for the DB to hold, so there is nothing to compare.

## Acceptance criteria

- [x] `/system-prompt` shows `~/.claude/CLAUDE.md` with its byte size, token estimate, line count,
      heading outline and modification time.
- [x] An absent file renders as an empty editor that says saving will create it, rather than an
      error.
- [x] The stats recompute on the draft as you type, using the same core functions the server uses
      on save.
- [x] Edit / Preview toggles between the editor and the rendered markdown.
- [x] Saving writes the file; the page then shows a fresh read of what landed, not the draft it
      sent.
- [x] `⌘S` / `Ctrl-S` saves; `Save` is disabled with no changes; `Revert` restores the file's text.
- [x] Every save over an existing file leaves the previous contents in `<path>.bak`; the first save
      reports no backup.
- [x] The write is atomic — temp file plus rename — and creates the parent directory when the whole
      `.claude` home is missing.
- [x] Saved text is normalized: CRLF becomes LF and the file ends in exactly one newline; a
      whitespace-only draft writes an empty file rather than a lone newline.
- [x] Emptying a non-empty prompt requires a second, armed click.
- [x] `Save` does not write: it re-reads the file and shows a line diff of the draft against what
      is on disk at that moment, through the shared `CodeBlock` and with no diff dependency.
- [x] The diff carries `@@` hunk headers, a few lines of context either side of each change, and
      tinted add/remove lines; a wholesale rewrite reads as a replacement rather than an
      alignment.
- [x] A file that changed since editing began is called out on that same screen, with the diff
      taken against the new contents, and takes a deliberate `Overwrite anyway`.
- [x] `POST /api/system-prompt` with a stale `expectedModified` is a 409 and leaves the file
      untouched; omitting the field writes regardless.
- [x] A non-string body and a body past the 200 KB ceiling are both 400s, and neither touches the
      file.
- [x] `POST /api/system-prompt` is refused from a foreign origin (403), and the GET still answers
      under the read CORS.
- [x] Core's outline, summary, normalization and parsing are unit-tested; the server's read, write,
      backup and rejection paths are tested against a real temp file; the route's methods and
      origin are tested against a spawned server; and `pnpm typecheck`, `pnpm test` and `pnpm build`
      pass.

## Open questions

- **The `.bak` is still one deep,** but it matters much less than it did. It existed because a
  save was blind; a save you read as a diff first, and that refuses to land on a file it has not
  seen, is a far smaller source of bad writes. A rotating backup under
  `~/.claude/.claude-md-history/` was the answer while the write was unsupervised — it is now
  worth doing only if bad saves actually turn up.
- **The diff is line-level only.** A reworded sentence reads as one line gone and one line
  arrived, with no intra-line highlighting. That is enough to decide whether to overwrite, which
  is what the screen is for, but it is coarser than a word diff would be.
- **The confirm step does not re-check while it is open.** The read happens once when `Save` is
  pressed; a change arriving while the diff is on screen is caught by the server's
  `expectedModified` check at write time rather than by the page noticing. That is correct but
  late — the reader learns about it from a refusal, then re-reads.
- **Only the device file.** Project instructions (`CLAUDE.md` / `AGENTS.md` in a repo) and the
  per-project memory the [project memory browser](project-memory-browser.md) shows are the other
  two layers that reach the system prompt, and neither is editable here. The device file was taken
  first because it is the one that costs every session everywhere.
- **The token estimate is `bytes / 2.78`,** the repo-wide approximation from
  `packages/core/src/context.ts`, where 2.78 is the median bytes-per-token of 530 cold-start
  requests in the log window rather than a guess. It still blends prose against dense
  punctuation, so a single file can sit either side of it; a real tokenizer would be exact but is
  a dependency this package does not have.
## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md) — the
  dashboard this page lives in.
- [Project memory browser](project-memory-browser.md) — the other view over authored `~/.claude`
  text, read-only.
- [Config inventory](config-inventory.md) — the sibling device-configuration pages.
- [Background jobs browser](background-jobs-browser.md) — the dashboard's other write, and the
  source of the armed-confirmation and origin-checked-write patterns reused here.
- [Context-size analytics](context-size-analytics.md) — where the tokens this file costs show up
  in aggregate.
