---
type: note
title: Wayfinder — Warm Cache
description: Campaign map for holding a named Claude Code session's prompt cache open while the user is away, capped at 8 hours, plus the /warm command that registers it.
tags: [wayfinder, proxy, cache, usage-limits, campaign]
timestamp: 2026-09-15
scope: claude
---

# Wayfinder — Warm Cache

**Slug:** `warm-cache`
**Integration branch:** `main` (cut from it, merged back into it; the planning and campaign pull requests target it — resolved from `--integration`, which named the repository default)
**Base branch:** `wayfinder/warm-cache` (cut from the integration branch above; every ticket targets it)
**Unattended:** `yes` (fixed at start by whether `--unattended` was typed there; `yes` means the kickoff prompt resumes this campaign unattended)
**Plans directory:** `docs/wayfinder`
**Started:** 2026-09-15
**Goal:** Hold a named session's prompt cache open while the user is away, for up to 8 hours, by re-sending that session's previous request with `max_tokens: 0` on a padded timer.

> Ephemeral scaffolding, on a schedule. Every `warm-cache-*.md` plan beside this file stays here for
> the campaign's life — marked done once its task lands — so any task can be restarted from what
> was asked. The final ticket `warm-cache-zz` deletes them all; this map goes when the wayfinder
> closes. The durable output is the merged code and the repository's feature and spec docs.

## Scope

**In scope.** A keep-alive module in claude's proxy; a 127.0.0.1-only control endpoint in
`handle()`; a `logs/warm.json` status mirror; the stop conditions; `node --test` coverage;
a feature doc; and a `/warm` command in the separate `my-command` repository.

**Out of scope.** Any admin dashboard route or card — see
[ADR 0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md). Any change to the
sidecar schema — see [ADR 0077](../adrs/0077-a-ping-never-enters-handle.md).

## Decisions this campaign rests on

Seven ADRs, written before charting from a five-round grill. They are the specification
and they override the original brief where they differ. **Four carry `needs-human: true`.**

| ADR | Decision | needs-human |
|---|---|---|
| [0073](../adrs/0073-keep-alive-is-justified-in-usage-units.md) | Justify the keep-alive in subscription `usageUnits`, not dollars | yes |
| [0074](../adrs/0074-cached-prefix-survives-local-midnight.md) | The cached prefix survives local midnight; no midnight cap | — |
| [0075](../adrs/0075-registration-stays-pending-until-matched.md) | A registration stays pending until a real request matches it | — |
| [0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md) | The ping takes the freshest same-account bearer, never the stored one | yes |
| [0077](../adrs/0077-a-ping-never-enters-handle.md) | A ping never enters `handle()`; `warm.json` is the ledger | yes |
| [0078](../adrs/0078-resume-rate-is-below-break-even.md) | The measured resume rate is below break-even; the 8-hour default ships anyway | yes |
| [0079](../adrs/0079-warm-json-ships-without-a-dashboard-card.md) | `warm.json` ships without a dashboard card | yes |

**[ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md) is the one a human most needs
to read.** It measures the feature's core premise at a 9.6% hit rate against a 15.5%
break-even and ships the specified default anyway.

## Waves

Lanes are file-scoped so nothing collides on the shared base branch.

- **Wave 1 — tickets 01, 03, 04.** Disjoint: a new proxy file, the docs bundle, and a
  different repository.
- **Wave 2 — ticket 02.** Edits `proxy.ts` and codes against 01's exported API.
- **Wave 3 — ticket zz.** Last, always.

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 01 | keepalive-module | [warm-cache-01-keepalive-module](warm-cache-01-keepalive-module.md) | `task/warm-cache-01-keepalive-module` | todo | |
| 02 | proxy-wiring-and-status | [warm-cache-02-proxy-wiring-and-status](warm-cache-02-proxy-wiring-and-status.md) | `task/warm-cache-02-proxy-wiring-and-status` | todo | |
| 03 | feature-doc | [warm-cache-03-feature-doc](warm-cache-03-feature-doc.md) | `task/warm-cache-03-feature-doc` | todo | |
| 04 | warm-command | [warm-cache-04-warm-command](warm-cache-04-warm-command.md) | `task/warm-cache-04-warm-command` | todo | |
| zz | retire-done-plans | [warm-cache-zz-retire-done-plans](warm-cache-zz-retire-done-plans.md) | `task/warm-cache-zz-retire-done-plans` | todo | Final ticket — deletes every plan. Execute last. |

<!--
Status is exactly one of these six:
  todo          — never started; nothing to resume. Pick it up.
  in-progress   — a ticket run is executing it now. Leave it alone.
  paused        — deliberately stopped, resumable as-is. Pick it back up.
  blocked-limit — the usage window ran out mid-run; nothing is wrong with the
                  work. Resume it once the window resets.
  rejected      — a human reviewed it and turned it down. Do NOT retry it; it
                  needs a new human decision or a rewritten plan.
  redo          — the work landed but must be done again differently. Restart
                  it from the plan.
Note is required for blocked-limit, rejected, and redo; empty for the rest.

The `zz` row is this campaign's final ticket. It always sorts last, it is executed
after every other task, and it deletes every plan in this directory. Do not drop it:
nothing else removes them, so without it they outlive the campaign permanently.
-->

## Completed

<!-- newest first; one entry appended per task completion -->

## Agent kickoff prompt

> Read this repository's own agent instructions, the wayfinder workflow, and the campaign
> map at `docs/wayfinder/wayfinder-warm-cache.md`. Inspect live version-control and
> worktree state rather than trusting any snapshot.
>
> Before choosing anything, repair stale rows. For every task marked in progress, check
> whether a run is really behind it — a live worktree, a branch pushed recently, an open
> pull request. Leave the ones that have one. For the rest, read the branch and rewrite
> the status: to stopped-by-usage-window where work is in hand, with a note saying when
> the window resets, and to never-started where there is nothing worth resuming.
>
> Then execute the next eligible task. A task is eligible when it was never started, was
> deliberately paused, was stopped because a usage window ran out and that window has
> since reset, or is marked for redoing differently. Never re-execute a task a human
> rejected — report it and pick another. A task marked in progress with a live run behind
> it belongs to that run.
>
> Run the task workflow against the task's plan with `wayfinder/warm-cache` as the base
> branch, and make sure the resulting pull request targets that branch rather than the
> repository default.
>
> The task numbered `zz` deletes this campaign's plan files. Execute it only when it is
> the last active task left; skip it while any other task is still active, and never drop
> it from the map — nothing else removes those files.
>
> If you stop before the pull request is open, set the task's status to say why, with a
> short note, rather than leaving it marked in progress.
>
> This map records the campaign as unattended, so type the wayfinder workflow's
> `--unattended` flag on the invocation you run. That routes the ticket through the
> merge-through runner, which resolves conflicts, waits for checks, retargets the pull
> request onto `wayfinder/warm-cache`, and merges it there. Do not stop at the open pull
> request — carry the ticket through to merged, still never leaving it targeting the
> repository default branch, and include the merge in what you report back.
