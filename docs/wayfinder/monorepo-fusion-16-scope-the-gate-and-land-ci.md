# monorepo-fusion-16 — Scope the filter gate to invocations and land the CI workflow

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-16-scope-the-gate-and-land-ci`
**Status:** done · 2026-08-23

## Why this ticket exists, and why it runs now

Two findings from tickets 03 and 04 converge on one ticket.

**This repository has no PR gate.** `gh pr checks` reports none; the only workflow is the
paths-filtered `deploy-concepts.yml`. Every ticket in this campaign has merged with
nothing mechanical checking it. Each runner's own `pnpm verify` is real, but ticket 03's
deliberately-red intermediate state was **unenforced rather than approved**, and the
difference matters as soon as one runner is wrong.

**The filter gate cannot go green without a decision**, and ADR 0057 makes it: 13
findings remain, all in the campaign's own plans and map, each quoting an unscoped filter
*as the defect being described*. CI is worth landing only on a tree that can be green.

This is ticket 10's `verify.yml` half pulled forward. Ticket 10 keeps the rest of the
toolchain merge.

## Criteria

1. **Scope `scripts/check-package-filters.mjs` per ADR 0057.** Read that ADR first — it
   is short and it is the whole rationale.
   - **Keep in scope:** source, scripts, `package.json`, `.github/workflows/`, `.plist`,
     and `AGENTS.md`.
   - **Exclude:** `docs/adrs/` and `docs/wayfinder/`.
   - **Do not weaken the pattern itself.** The gate must still fail on a bare unscoped
     name anywhere it does look. This narrows *where* it looks, not *what* it catches.
   - Put the reason in a comment at the exclusion, citing ADR 0057. A future reader who
     finds an exclusion with no reason deletes it.
2. **Confirm the gate is green** on the current tree with no citation edited, and confirm
   it still fails a planted unscoped filter in an in-scope file. Both halves — a gate that
   passes because it stopped looking is the failure this ticket is preventing, not
   causing.
3. **Land `.github/workflows/verify.yml`**, codex's version, one step per gate so a
   failure names the gate in the checks list.
   - **Extend the `push` trigger** beyond codex's `main` to include `the-great-merge` and
     `wayfinder/monorepo-fusion`, so campaign commits are gated too.
   - Its `pull_request` trigger is unfiltered and already covers every campaign PR.
   - `pnpm install --frozen-lockfile`, Node 22, pnpm cache — as codex has it.
4. **Add the root `verify` script** if it is not already there: `pnpm typecheck && pnpm
   test && pnpm build && pnpm check && pnpm anti:slop`. Note that root `verify` chains a
   **fixed** list rather than discovering by prefix, so a new gate must be added to the
   chain explicitly or hung off one already in it.
5. **Confirm CI actually runs and reports on a PR.** The point of this ticket is a gate
   that fires. A workflow that lands but never triggers is indistinguishable from no
   workflow at all — which is exactly the failure mode blocker (f) describes for
   `deploy-concepts.yml`. Check `gh pr checks` on this ticket's own PR and put the result
   in the PR body.

## Constraints

- Do not edit any plan file's or ADR's citation text to make the gate pass. That is the
  thing ADR 0057 forbids, and doing it here would destroy the same evidence the ADR was
  written to protect.
- **Zero behaviour change** still holds for the three stacks.

## Ordering

Runs immediately after ticket 04 and **before ticket 05**, so codex and ox are absorbed
under a live gate rather than under none.

## Done when

`pnpm check:names` is green with no citation edited, a planted unscoped filter in an
in-scope file still fails it, `pnpm verify` is green, `verify.yml` is committed, and
`gh pr checks` on this ticket's PR shows the workflow having actually run.
