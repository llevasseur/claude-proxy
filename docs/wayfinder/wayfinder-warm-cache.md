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

## Standing — 2026-09-15: incomplete, and both blockers need a human

Two of four tickets landed on `wayfinder/warm-cache`. **Neither remaining blocker is a
problem with the work, and neither can be cleared by an agent** — both need a human at this
device.

- **Ticket 02** — complete and passing (157/157 proxy tests), five files staged, **zero
  commits**. `git commit` fails with `1Password: failed to fill whole buffer` /
  `fatal: failed to write commit object`, an unapproved signing prompt. AGENTS.md forbids
  the three workarounds (rewriting the commit, `--no-gpg-sign`, changing signing config),
  and the one blessed retry was spent and hit the identical prompt. **The worktree at
  `.claude/worktrees/task-warm-cache-02-proxy-wiring-and-status` holds the only copy of
  that work — do not remove it.**
- **Ticket 04** — built, reviewed, green, and `MERGEABLE` as
  [llevasseur/my-command#146](https://github.com/llevasseur/my-command/pull/146). The merge
  was refused by the auto-mode classifier, and a refused merge is final.

**The campaign PR must not be merged while ticket 02 is unlanded**, because the feature is
inert without it: ticket 01 shipped the module and nothing calls it yet.

**The `zz` ticket has deliberately not been run.** It deletes every plan in this directory,
including ticket 02's — which is the resume path for the one ticket still outstanding.
Retiring the scaffolding now is what would make this campaign unresumable.

Resume with `/dev --resume warm-cache` once the signing prompt is approved.

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
| 02 | proxy-wiring-and-status | [warm-cache-02-proxy-wiring-and-status](warm-cache-02-proxy-wiring-and-status.md) | `task/warm-cache-02-proxy-wiring-and-status` | paused | Work complete and passing (157/157 proxy tests), five files staged, zero commits. Blocked on an unapproved 1Password signing prompt on this device. Worktree left standing at `.claude/worktrees/task-warm-cache-02-proxy-wiring-and-status` — it holds the only copy. Resume: approve the prompt, then `git commit -F /tmp/warm-cache-02-commit.txt` in that worktree, then `/clean`, `/pr`, retarget to `wayfinder/warm-cache`, merge. |
| 04 | warm-command | [warm-cache-04-warm-command](warm-cache-04-warm-command.md) | `feat/warm-command` (in `my-command`) | paused | Built, reviewed, green. PR llevasseur/my-command#146 is OPEN and MERGEABLE; the merge was refused by the auto-mode classifier, which is final. Needs a human: `gh pr merge 146 --squash`, then `my-command-tools cleanup --branch feat/warm-command`. |
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

### 01 — keepalive-module · 2026-09-15 · PR #337

Added `stacks/claude/proxy/keepalive.ts` (657 lines) and `keepalive.test.ts` (420 lines,
37 cases), merged into `wayfinder/warm-cache`. Zero runtime dependencies, in-memory only.

Named off the colliding `warm` identifier as ADR 0077 §5 requires, with the distinction
against `cache-breakpoint.ts`'s `warmSessions` stated in the file header. Exports
`buildPingBody`, `deriveTtlMs`, `clampDeadlineHours`, `startKeepalive`, `noteRequest`,
`setBearerSource`, `usageLiveUtilization`, and `_resetKeepalive`. The ping issues its own
`https.request`, so there is no enumerated skip list anywhere in the file — the property
falls out of the architecture, which is what ADR 0077 asked for.

**Deviations worth keeping.** `deriveTtlMs` falls back to a 5-minute default (the API's own
ephemeral default) when no `cache_control` carries a TTL; the plan required a documented
fallback without naming one. Seven distinct stop reasons were implemented rather than a
generic failure path: `deadline`, `unmatched`, `ping-failures`, `rate-limited`,
`credential-expired`, `usage-limit`, `released`.

**One "Done when" clause was deliberately not met, and ticket 02 closed it:** the plan
required the new tests to run under the proxy package's own `node --test` script, but that
script's file list lives in `package.json`, outside this ticket's lane. The ticket reported
it rather than widening the lane.

### 03 — feature-doc · 2026-09-15 · PR #336

Added `docs/features/keep-a-chat-warm.md` (+254), regenerated `docs/features/index.md`, and
prepended one `CHANGELOG.md` bullet. Merged into `wayfinder/warm-cache`.

Written on `retention-lifecycle.md`'s model — Summary, a Motivation leading with the
measurement, Behavior. All seven ADRs 0073–0079 cross-linked by relative path.

**The counter-measurement is not softened**, which was the ticket's sharpest requirement.
It sits in the Motivation under the heading "The base rate is 9.6%. Break-even is 15.5%.",
ahead of the usage instructions rather than in a footnote, and states the honest 5.8%–9.6%
band once the two worthless single-request resumes are discounted, the 9.9-minute median
lifetime, and that no session lived past 3.6 hours so the 8-hour cap was never exercised by
the evidence. The sample's limits are restated wherever a number appears.

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
