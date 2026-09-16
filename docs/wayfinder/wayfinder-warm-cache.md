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

## Standing — 2026-09-16: all four tickets landed

Every ticket is merged. The two blockers recorded here on 2026-09-15 — an unapproved
1Password signing prompt holding ticket 02's commit, and a classifier refusal on ticket
04's merge — both cleared, and the work landed unchanged from what was already written and
passing.

**Verified against a running proxy**, not only against unit tests. With the feature merged,
the proxy was started on port 8791 and the endpoint exercised end to end: `GET /__warm`
answers the `usage-live.json`-shaped document; `POST` registers as `pending` with an 8-hour
deadline; `hours: 99` clamps to 8 and reports `requestedHours: 99` alongside it rather than
swallowing the value; `DELETE` releases and records `outcome: "stopped-released"`; and
`logs/warm.json` is written carrying status only, with zero matches for any credential or
body marker.

**One link is still unverified, exactly as [ADR 0075](../adrs/0075-registration-stays-pending-until-matched.md)
records it.** Registering this session's real `CLAUDE_CODE_SESSION_ID` leaves the entry
`pending`, because no traffic from that session reaches this proxy — which demonstrates the
handshake refusing to claim a session it has not seen, and still does not join the
environment variable to the two header values. That link needs a live client pointed at the
proxy.

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

None. Every ticket is complete, and the `zz` ticket has retired every plan in this
directory. This map is the last of the campaign's scaffolding and the close operation
retires it.

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|

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

### zz — retire-done-plans · 2026-09-16

Deleted all five `warm-cache-*.md` plan files, this ticket's own included, and regenerated
`docs/wayfinder/index.md`. The map is left standing for the close operation to retire.

No plan was marked done for this one, because the ticket deletes its own plan — that is the
one completion in a campaign with nothing left to mark.

**Deviation:** run directly by the campaign owner rather than dispatched as its own ticket
run. Every other ticket had already landed, its whole criteria are five deletions and an
index regeneration, and a worktree-and-PR cycle for that would have cost more than it
bought. Nothing outside `docs/wayfinder/warm-cache-*` was touched: the sibling campaigns'
plans (`monorepo-fusion-*`, `provider-seam-*`, `map-*`, `research-*`, `decision-*`) are
untouched, and so are `docs/adrs/` and `docs/features/`.

### 04 — warm-command · 2026-09-16 · my-command#146

Added `/warm` to the separate `my-command` repository: `src/commands/warm.md` (the bare
source), the generated `commands/warm.md`, the Codex skill `skills/warm/SKILL.md`, and
`docs/features/warm.md`. Merged into that repository's own `main`. Command count went
31 → 32 with every authoring invariant satisfied.

The command is one curl and nothing else — no arguments, no state, no teardown, no
follow-up poll — so it is correct when `/task --add warm` fires it once at the start of a
run.

**Two things it refuses to do, both deliberate.** It never reports the registration as
warm: "session kept warm" and "cache warmed" are forbidden wording in the body, because a
pending registration that nothing matches expires silently with no second message to
correct the record. And a refused connection is reported once as "the proxy is not
running", with retrying, polling and falling back to another port each ruled out by name.

It sends `hours: 8` as specified, and says in its own text that the value is not the
agent's to tune while recording the lower recommendation from
[ADR 0078](../adrs/0078-resume-rate-is-below-break-even.md) as guidance.

**Deviation:** it landed a day later than its siblings. The merge was refused by the
auto-mode classifier on 2026-09-15 and went through unchanged on 2026-09-16; nothing about
the work changed in between.

### 02 — proxy-wiring-and-status · 2026-09-16 · PR #339

Wired the keep-alive module into `handle()` behind a loopback-only `/__warm`, merged into
`wayfinder/warm-cache`. Five files, 892 insertions: `proxy.ts`, `usage-live.ts`,
`package.json`, the new `warm.test.ts`, and a `CHANGELOG.md` bullet.

The control endpoint is answered as the first thing in `handle()`, ahead of `noteAuth`, the
body parse, `isTokenCount` and the skim gate. Loopback is enforced on the **peer address
rather than on `HOST`**, covering `127.0.0.0/8`, `::1` and `::ffff:127.x`, so `HOST=""`
binding all interfaces cannot carry the endpoint off-box. `usage-live.ts` grew an
account-keyed bearer store wired into `setBearerSource`, leaving the global bearer and the
usage poll unchanged.

**Three judgement calls the ticket flagged for review, all kept.**
`bearerForAccount(null)` returns `null` rather than falling back to the global bearer,
because "no cross-account fallback" is the whole point of the scoping in
[ADR 0076](../adrs/0076-ping-takes-the-freshest-same-account-bearer.md) — an entry with no
account of its own stops as `no-credential`. `resumed` is observed in `handle()` rather
than added to `keepalive.ts`, since resuming is the user coming back rather than the entry
retiring. And the capture is deliberately **not** on the skim-hit path: a skim hit never
reaches Anthropic, so counting it as activity would push the ping back while the upstream
cache carried on expiring.

**It closed ticket 01's open follow-up.** `keepalive.test.ts` was in no CI at all, because
the package's test script enumerates its files by hand and ticket 01's lane excluded
`package.json`. It is enumerated now, and a guard test fails whenever any sibling
`*.test.ts` is missing from that list, so the class of bug cannot recur. Proxy suite:
157/157.

**Constraint discovered:** the metering weight could not be pinned by importing
`usage-limits.ts`, because the proxy's `tsconfig` sets `rootDir: "."` and the proxy must
stay dependency-free. The test reads core's file text and asserts the literal instead,
which pins the two without an import.

**Deviation:** the work was complete and passing on 2026-09-15 but uncommitted, blocked on
an unapproved signing prompt. It was committed unchanged on 2026-09-16.

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
