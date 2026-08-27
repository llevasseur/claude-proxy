---
type: adr
title: A campaign clears its own lint debt rather than merging red or waiving the rule
description: stacks/net landed 74 anti-slop errors ungated because my-command-tools verify does not discover anti:slop; the campaign clears them as its own ticket instead of granting net a warn tier.
tags: [lint, ci, campaigns, net]
timestamp: 2026-08-27
scope: all
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 0
needs-human: true
---

# A campaign clears its own lint debt rather than merging red or waiving the rule

## Status

Proposed by `/dev` during the `internet-spend` campaign, resuming it unattended.
**A human has not ratified this decision.** Flagged `needs-human` for the second
half of it: the gate gap described below is a repository-wide toolchain fact
that outlives this campaign, and closing it changes what every future ticket is
checked against.

## Context

This decision came from a ticket outcome rather than from a grill round, so
there is no griller question to quote. Ticket 03 of the campaign finished its
work, passed every gate it ran locally, and then stopped short of merging with
this report:

> The `Verify` workflow fails on its `pnpm anti:slop` step with 74 errors.
> Grouped by file, all 74 are in `stacks/net/packages/server/**` […] Every one
> is a ticket 01 or ticket 02 file that this PR does not touch, and zero are in
> `stacks/claude/admin/**`. The repair round would mean editing another ticket's
> files, which my brief forbids and which I will not do silently.

Both halves were verified independently before this record was written.

**The 74 errors are real.** `pnpm anti:slop` on `wayfinder/internet-spend` exits
1 with exactly 74 findings, every one under `stacks/net`: 40
`require-safety-comment-for-type-assertion`, 16 `no-chained-type-assertions`, 8
`no-known-value-widening`, 6 `no-runtime-typeof`, 3 `no-unknown-parameters`, 1
`no-unsafe-dictionary-type`. Most sit in the package's tests.

**They landed ungated.** `gh pr checks 312` answers "no checks reported", and
`gh run list` for ticket 02's branch is empty. Tickets 01 and 02 merged without
CI ever running, so PR #313 is the first CI execution anywhere on this campaign
and it surfaced debt two earlier tickets had already merged.

**The cause is a gate the local verifier does not run.** The root `verify`
script is `pnpm typecheck && pnpm test && pnpm build && pnpm check && pnpm
anti:slop`, but `my-command-tools verify` does not run that script — it
discovers and runs the root scripts individually (`typecheck`, `test`, `build`,
`check`, `lint`, `check:env`, `check:names`), and `anti:slop` is not among them.
So a ticket can be locally green across eight gates and still fail CI on a ninth
it was never offered. Ticket 03 hit exactly that.

## Decision

**The campaign clears the `stacks/net` findings as a ticket of its own**, on the
campaign base branch, before ticket 03 merges. Three alternatives were rejected:

- **Merging PR #313 red** is refused outright. `/dev` may not merge a red pull
  request, and a campaign is precisely where one bad merge is multiplied.
- **Widening ticket 03's lane** to let it repair another ticket's files would
  make a reviewed, scoped pull request silently touch a package it was never
  briefed on.
- **Granting `stacks/net` a `warn` tier** beside `stacks/ox-alpha` and
  `stacks/codex` misreads why that tier exists. `AGENTS.md` is explicit that the
  tier is a countdown for *absorbed* code whose runtime behaviour the fusion
  campaign forbids changing, and that its remedies were rejected because they
  would alter how that code handles malformed input. `stacks/net` is new code
  this campaign wrote days ago, under no such constraint, and most of its
  findings are missing `SAFETY:` comments in tests — annotations, not behaviour
  changes. A warn tier here would convert a rule the repository enforces into
  one it merely mentions, which is the drift the ratchet exists to prevent.

**Campaign tickets run `pnpm anti:slop` explicitly** in addition to
`my-command-tools verify`, for as long as the helper does not discover it.

## Consequences

The campaign grows one ticket and ticket 03 merges after it rather than before.
`stacks/net` enters `main` at the same severity every non-absorbed stack is held
to, so the ox and codex `warn` blocks stay the only two and neither is widened.

**What a human still owes a decision on**: whether `my-command-tools verify`
should discover `anti:slop`, or whether the root `verify` script should be what
the helper runs. Until one of those happens, every ticket in this repository can
pass locally and fail in CI on a gate it never ran, and the only reason this
campaign caught it is that CI had never run at all before ticket 03.
