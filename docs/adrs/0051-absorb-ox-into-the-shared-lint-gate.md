---
type: adr
title: Absorb ox into the shared lint gate at a warn tier, and split its delta by fixability
description: ox source lands under one biome config with auto-fixable findings fixed outright and judgement findings ratcheted from warn to error; codex's inherited oxlint warn tier is covered by the same ratchet and expiry.
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

**codex is on an anti-slop `warn` tier too, and this record now covers it.** As first
written, this record was about ox alone, and everything above stays true of ox. What
follows is an amendment made by ticket 24, and the first thing to say about it is how
codex's tier came to exist: **it was discovered, not designed.** Nobody chose it during
this campaign. `stacks/codex/.oxlintrc.json` extends the root config and restates
anti-slop rules at `warn` where the root sets `error` — the tier codex-proxy enforced on
itself before absorption, carried across whole when ticket 05 absorbed the repository.
Ticket 05 reported that the config "restates its severities", which later tickets read as
*restoring* root severity rather than restating a lower one; ticket 21's dispatch went on
to state outright that codex was not under a warn tier. Ticket 21 measured that claim to
be false, and ticket 24 measured how large the tier is. An undocumented tier looks
identical to compliance and never shrinks, because nobody knows it is there to shrink —
which is the failure the ratchet exists to prevent, so codex gets the same ratchet and the
same expiry as ox rather than a dispensation of its own.

**Starting counts, measured at root severities** with oxlint 1.78.0 —
`oxlint --config .oxlintrc.json stacks/codex/`, where `--config` disables nested-config
resolution and so applies `error` throughout. **123 diagnostics across 19 files**, at 115
distinct positions; the 8 duplicates are a second
`require-safety-comment-for-type-assertion` at a position that also carries
`no-chained-type-assertions`, all in `stacks/codex/server/src/database.ts`. By package:
server 59, apps 29, packages 27, proxy 8.

| Rule | Starting count | Distinct positions |
|---|---|---|
| `require-safety-comment-for-type-assertion` | 54 | 46 |
| `no-unknown-parameters` | 21 | 21 |
| `no-runtime-typeof` | 21 | 21 |
| `no-unsafe-dictionary-type` | 14 | 14 |
| `no-chained-type-assertions` | 8 | 8 |
| `no-known-value-widening` | 3 | 3 |
| `no-unknown-returns` | 2 | 2 |

**The other eight of the fifteen rules fire zero times, so they return to `error` now.**
The ratchet says a rule at zero goes back to `error`, and applying it at the moment of
writing rather than later is what keeps the tier honest — the same call ticket 08 made for
ox's `useExhaustiveDependencies`. Removed from codex's restatement and left to inherit the
root's `error`: `no-conditional-empty-object-spread`, `no-module-mocking`,
`no-object-parameters`, `no-reflect-apply`, `no-reflect-get`, `no-shape-in-symbol-names`,
`no-unknown-type-aliases`, `no-widen-then-assert`. codex's config now names seven rules
instead of fifteen, and that list is the counter.

**The tier survives because clearing it would change behaviour, not because 123 is a large
number.** 69 of the 123 sit on rules whose only remedy is to parse input at its I/O
boundary or to replace an `unknown` or open-dictionary type with a domain type —
`no-unknown-parameters`, `no-runtime-typeof`, `no-unsafe-dictionary-type`,
`no-chained-type-assertions`, `no-known-value-widening`, `no-unknown-returns`. Adding a
parser at a boundary changes what codex does with malformed input, which is exactly the
runtime change this campaign forbids, and it is the same ground on which ox's
`useExhaustiveDependencies` fixes were rejected above. The remaining 54 are
`require-safety-comment-for-type-assertion`, which is comment-only and carries no such
risk — but clearing those alone cannot retire the tier, since the restatements only come
out when every rule reaches zero.

**The ratchet and the expiry are ox's, unchanged**: a rule moves from `warn` back to
`error` once its count reaches zero, every file a ticket touches must pass at `error`
before that ticket is done, and the restatements are expected to be gone by the end of
campaign 3. `off` is never the answer — `off` is invisible, `warn` is a countdown.

## Consequences

- On the day the campaign closes, `pnpm verify` asserts: `biome check` exits 0 with ox
  formatting and import order fully conformant and **zero errors anywhere**; residual
  `warn` diagnostics from named rule lists on ox source and — per the amendment above —
  on codex source; typecheck, test and build passing on ox unchanged.
- **Two stacks are on a warn tier, not one.** ox's is designed and counted here from the
  start; codex's is inherited, was measured only at ticket 24, and is counted here from
  that measurement. Both shrink under the same ratchet and both expire at the end of
  campaign 3. Anything written on the premise that codex sits at root severity — ticket
  21's dispatch is the recorded case — is wrong about this repository.
- One config file, one `pnpm verify`, one workflow — with one time-limited `overrides`
  block naming one stack and one rule list, which shrinks monotonically and is empty by
  the end of campaign 3. This is a ratchet with a visible counter, and it is accepted
  as the cost of not editing ox source under a zero-behaviour-change campaign.
- The alternative was rejected on those grounds: `useExhaustiveDependencies` fixes in a
  React admin are exactly the kind that alter runtime behaviour.

## Provenance

Extends the oxlint absorption policy recorded in codex-proxy's `AGENTS.md` to biome.
No prior record covers biome's linter against unlinted absorbed source.
