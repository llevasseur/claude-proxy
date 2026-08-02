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

This one file is the highest-leverage text on the device and the least visible. It is loaded into
every session, so every byte in it is paid for on every request, forever — and nothing in the
dashboard showed it. The proxy never records it either: it arrives inside the system prompt, which
the [context-size analytics](context-size-analytics.md) count in aggregate but do not break down.
So the question "what is in my device instructions, and what are they costing me?" had no answer
short of opening the file in an editor.

Two things follow from that:

- **Reading it is only half the job.** The reason to look at device instructions is almost always
  to change them — trim a stale rule, add one a retro produced. A read-only view would send you to
  an editor anyway, and then back here to see what it cost.
- **It is authored state with no version control behind it.** `~/.claude` is not a git repo. An
  overwrite that goes wrong loses text a human wrote and cannot reconstruct, which is a different
  risk from the dashboard's other write ([deleting a job](background-jobs-browser.md), which
  removes machine-generated scratch). The write path is built accordingly.

The token estimate is the point of the size tiles. At the repo's `bytes / 4` estimate a 12 KB
instruction file is roughly 3000 tokens on every request of every session — worth seeing next to
the text that produced it.

## Behavior

- **System prompt** (`/system-prompt`) — **Size / Est. tokens / Lines / Modified** tiles over an
  editor holding the file's text. Size reads `N on disk` underneath while there are unsaved
  changes, so the tile states both numbers rather than silently meaning one of them. Lines carries
  the section count from the outline. Est. tokens is labelled *per request*, because that is the
  unit that matters.
- **The stats are live on the draft, not the file.** Every keystroke re-measures bytes, re-derives
  the outline and re-estimates tokens from the text in the editor, using the same core functions
  the server uses on save — so a paragraph's cost is visible before it is committed to disk, and
  the numbers cannot disagree with what a save would produce.
- **Edit / Preview** — a segmented toggle between the editor and the file rendered as markdown
  through the dashboard's `Markdown` renderer, since the file is markdown and headings are how it
  is organised.
- **Saving** — `Save` is enabled only while the draft differs from disk; `Revert` restores the
  file's text. `⌘S` / `Ctrl-S` saves from the editor. The response carries a fresh read of the
  file, which seeds the query cache directly, so the page shows what is *on disk* after a save
  rather than what it hoped it wrote.
- **Emptying the prompt is armed.** Saving an empty draft over a non-empty file takes a second
  click, because it discards authored text and the keystroke that gets you there
  (`⌘A`, `Delete`, `⌘S`) is short.
- **A file that does not exist yet** is not an error: the page opens on an empty editor and says
  saving will create it, which is the true first-run state on a device that has never written
  device-wide instructions.
- **Too large is refused before it is written.** A draft past the 200 KB ceiling disables the save
  and says so; the server refuses it independently.

Data flows `~/.claude/CLAUDE.md` → `server` → `packages/core` → `apps/admin`, with core in the
middle for both directions. The shaping is pure and browser-safe (`TextEncoder`, not `Buffer`) —
`outlineSystemPrompt`, `summarizeSystemPrompt`, `normalizeSystemPromptText`,
`parseSystemPromptText` and `utf8Bytes` in `packages/core/src/system-prompt.ts` — which is what
lets the page compute the draft's stats with the *same* code that measures the saved file. File
I/O is `server/src/system-prompt.ts` (`resolveSystemPromptPath`, `readSystemPromptFile`,
`writeSystemPromptFile`). The path is `~/.claude/CLAUDE.md`, overridable with
`CLAUDE_SYSTEM_PROMPT` — which is also how the tests drive the write path without touching the
real file. The endpoint is `GET /api/system-prompt` (the file, its outline and the ceiling) and
`POST /api/system-prompt` (`{ text }` → the same shape plus the backup path).

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
- No path arrives from the request. The file is resolved **once at server start** from the
  environment, so there is no id or filename to traverse with — unlike the jobs routes, this one
  cannot be pointed anywhere.

Overwriting authored text gets two safeguards beyond that:

- **A `.bak` first.** Every save that finds an existing file copies it to `<path>.bak` before
  writing, so the previous contents survive a bad edit. The first save has nothing to back up and
  reports `backupPath: null`.
- **An atomic write.** The new text goes to `<path>.<pid>.tmp` and is then `rename`d into place, so
  an interrupted write cannot leave a half-file where the device instructions should be.

Text is normalized before it lands — CRLF to LF, trailing blank lines collapsed to exactly one
closing newline — so the file does not accumulate whitespace churn across saves. An emptied prompt
is written as an empty file rather than deleting it, keeping "no instructions" distinct from "the
file went missing".

`/api/system-prompt` is deliberately **outside the SQLite parity harness**, alongside
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
- [x] A non-string body and a body past the 200 KB ceiling are both 400s, and neither touches the
      file.
- [x] `POST /api/system-prompt` is refused from a foreign origin (403), and the GET still answers
      under the read CORS.
- [x] Core's outline, summary, normalization and parsing are unit-tested; the server's read, write,
      backup and rejection paths are tested against a real temp file; the route's methods and
      origin are tested against a spawned server; and `pnpm typecheck`, `pnpm test` and `pnpm build`
      pass.

## Open questions

- **The `.bak` is one deep.** Two bad saves in a row lose the good text. A rotating backup, or
  keeping the last N under `~/.claude/.claude-md-history/`, would make the page safe to experiment
  in rather than merely safe to use carefully.
- **Nothing detects a concurrent edit.** If the file changes on disk while the page is open —
  another editor, another agent — a save overwrites it without noticing. The read already returns
  `modified`; sending it back and refusing a stale write is the obvious next step.
- **Only the device file.** Project instructions (`CLAUDE.md` / `AGENTS.md` in a repo) and the
  per-project memory the [project memory browser](project-memory-browser.md) shows are the other
  two layers that reach the system prompt, and neither is editable here. The device file was taken
  first because it is the one that costs every session everywhere.
- **The token estimate is `bytes / 4`,** the repo-wide approximation from
  `packages/core/src/context.ts`. It is right to within a fifth or so for prose and wrong for
  dense punctuation; a real tokenizer would be exact but is a dependency this package does not
  have.
- **No diff on save.** You cannot see what changed between the file and the draft, which is what
  you actually want before overwriting a long instruction file.

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
