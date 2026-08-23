---
type: adr
title: Absorb ox into the shared lint gate at a warn tier, and split its delta by fixability
description: ox source lands under one biome config with auto-fixable findings fixed outright and judgement findings ratcheted from warn to error.
tags: [monorepo, tooling, lint]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 2
needs-human: false
---

# Absorb ox into the shared lint gate at a warn tier, and split its delta by fixability

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. A human has not ratified it.
Not flagged `needs-human`: this is an implementation policy for absorbing unlinted
source, and it extends a policy the repository already holds rather than choosing a
new one.

## Context

The campaign gave oxlint an explicit staging design — land ox at `warn` behind path
overrides, ratchet per rule to `error` at zero — but gave biome none, describing it
only as "claude-proxy wins, verbatim" plus an isolated reformat commit for quote style
and column width. That treats biome as a formatter. It is also a linter, and the
reformat commit does nothing for the linter. The griller asked:

> "What is the acceptance rule for biome's *linter and assist* output on ox source —
> does it get the same warn-tier-and-ratchet treatment oxlint gets (in which case say
> so explicitly, since 'claude-proxy wins, verbatim' currently reads as the opposite),
> or is ox pinned at its own biome settings behind an override until a later campaign,
> and either way what is `pnpm verify` actually asserting about ox on the day this
> campaign closes?"

The delta is not symmetric. codex's `biome.json` is claude's almost line for line.
ox's is nine lines of rules with no `overrides`, no `vcs`/`useIgnoreFile`, no `assist`,
no `plugins`, and pins `@biomejs/biome` at `~2.2.0` against claude's `^2.5.6` — so ox
source has never been checked by the recommended rules added in 2.3 through 2.5, and
has never had `organizeImports` enforced.

## Decision

**ox gets the same warn-tier-and-ratchet for biome that it gets for oxlint**, stated
explicitly because the brief's wording reads as the opposite. Applying one absorption
policy to oxlint and a different one to biome, for the same source, would be
incoherent.

**ox's biome delta splits into two piles by fixability:**

1. **Auto-fixable — fixed outright in the isolated reformat commit.** Double to single
   quotes, 100 to 120 columns, **and `organizeImports`**. The assist action fails
   `biome check` and the quote/column reformat does not touch it, so it moves into the
   same commit, which `biome check --write` performs in one pass. Widening that commit
   from "formatter" to "everything biome can fix without judgement" is the honest
   version of what it already claims to be. It stays isolated and stays in
   `.git-blame-ignore-revs`.
2. **Judgement findings — `warn`, ratcheted per rule to `error` at zero.**
   `useExhaustiveDependencies`, `noBarrelFile`, and the rest of the added recommended
   set. Path-scoped to `stacks/ox-alpha/**`, at `warn` and never `off`, because `off`
   is invisible and `warn` is a countdown. **Every file a ticket touches must pass at
   `error` before that ticket is done.**

**The GritQL `no-bare-size` plugin cannot be scoped in Biome 2.5.6, and this record was
wrong to say it could.** As first written, this section said the plugin is "rescoped to
`stacks/claude/admin/**`". Two tickets established that no such scoping exists in the
pinned version: `plugins` is a **top-level array applying repo-wide**, and the path in it
says only where the plugin *file* lives, not what it inspects (ticket 07); and 2.5.6
supports neither `overrides[].plugins` nor plugin suppression comments (ticket 05).

So the plugin stays repo-wide and the sibling stacks' few bare-px sites are **rewritten
mechanically instead** — which is what ticket 05 already did for codex's one
`margin: -1px` in `.sr-only`. A token-level CSS edit with no behavioural effect is not the
design work this campaign forbids, and the exposure is bounded: two sites in ox, one in
codex.

The plugin header's premise — "the dashboard sheet is the only CSS in the repo" — is now
false and stays false. It is corrected in `AGENTS.md` rather than defended.

**Root version pins win**: biome `^2.5.6`, oxlint exactly `1.78.0`, one TypeScript.
The single lockfile forces this regardless.

## Consequences

- On the day the campaign closes, `pnpm verify` asserts: `biome check` exits 0 with ox
  formatting and import order fully conformant and **zero errors anywhere**; residual
  `warn` diagnostics on ox source only, from a named rule list; typecheck, test and
  build passing on ox unchanged.
- One config file, one `pnpm verify`, one workflow — with one time-limited `overrides`
  block naming one stack and one rule list, which shrinks monotonically and is empty by
  the end of campaign 3. This is a ratchet with a visible counter, and it is accepted
  as the cost of not editing ox source under a zero-behaviour-change campaign.
- The alternative was rejected on those grounds: `useExhaustiveDependencies` fixes in a
  React admin are exactly the kind that alter runtime behaviour.

## Provenance

Extends the oxlint absorption policy recorded in codex-proxy's `AGENTS.md` to biome.
No prior record covers biome's linter against unlinted absorbed source.
