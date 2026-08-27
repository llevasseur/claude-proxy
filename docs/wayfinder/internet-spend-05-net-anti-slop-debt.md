---
type: wayfinder-plan
title: "Internet Spend 05 — clear the stacks/net anti-slop debt"
description: The 74 anti-slop errors tickets 01 and 02 landed ungated, cleared at root severity so the campaign base goes green in CI.
tags: [wayfinder, lint, net]
timestamp: 2026-08-27
scope: net
campaign: internet-spend
number: "05"
---

# Internet Spend 05 — clear the stacks/net anti-slop debt

Branch: `task/internet-spend-05-net-anti-slop-debt`, cut from `wayfinder/internet-spend`.
Lane: `stacks/net/**` only, plus `CHANGELOG.md`. Touch nothing under
`stacks/claude/`, `stacks/codex/`, `stacks/ox-alpha/`, and do not edit
`.oxlintrc.json` or `biome.json`.

Why this ticket exists: [ADR 0066](../adrs/0066-a-campaign-clears-its-own-lint-debt.md).
Tickets 01 and 02 merged without CI ever running, so 74 `anti:slop` errors
reached the campaign base unnoticed. PR #313 (ticket 03) is red because of them
and cannot merge until they are gone.

## Criteria

1. **`pnpm anti:slop` exits 0** from the repository root on this branch. That is
   the whole point of the ticket; it is currently 74 errors, every one under
   `stacks/net/packages/server/`.
2. **Fix at root severity — do not waive.** Adding `stacks/net` to the
   `overrides` block in `biome.json`, adding a `stacks/net/.oxlintrc.json`, or
   demoting any rule to `warn` or `off` is out of scope and explicitly refused
   by ADR 0066. The `warn` tier exists for absorbed stacks whose runtime
   behaviour must not change; `stacks/net` is new code under no such constraint.
   Per-site suppression comments are equally out of scope: fix the finding.
3. **The findings, by rule** (counts from a root run on the campaign base):
   - `require-safety-comment-for-type-assertion` (40) — state the checked
     invariant in a `SAFETY:` comment immediately before the assertion or its
     containing statement. In tests this is usually one line naming what the
     fixture guarantees.
   - `no-chained-type-assertions` (16) — keep the original precise type, or
     parse at the boundary rather than chaining through `as unknown as`.
   - `no-known-value-widening` (8)
   - `no-runtime-typeof` (6)
   - `no-unknown-parameters` (3)
   - `no-unsafe-dictionary-type` (1)
4. **Behaviour does not change.** This is an annotation and typing pass. Where a
   finding cannot be cleared without altering what the code does with malformed
   input, stop and say so in the PR body rather than changing behaviour quietly
   — that is the one case worth escalating, and it should be rare, since most
   findings are missing comments in tests.
5. **The whole existing suite still passes**: `pnpm --filter @agent-proxy/net-server test`
   green with the same number of passing cases as before (82), and
   `pnpm --filter @agent-proxy/net-server typecheck` green.
6. `my-command-tools verify` green, **and `pnpm anti:slop` run explicitly on top
   of it** — the helper does not discover that script, which is the gap ADR 0066
   records and the reason this debt existed at all.
7. `biome check .` green; a `CHANGELOG.md` bullet prepended.

## Verification

Run `pnpm anti:slop` from the repository root and confirm exit 0 with zero
`stacks/net` findings. State the before and after counts in the PR body.
