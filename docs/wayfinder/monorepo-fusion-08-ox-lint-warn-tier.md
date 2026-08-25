# monorepo-fusion-08 — Land ox's judgement findings at a warn tier

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-08-ox-lint-warn-tier`
**Cut from and merged into:** `task/monorepo-fusion-07-reformat-ox` — **not** the campaign
base. Third in a stack: 08 → 07 → 06 → base. This ticket is what returns the tree to green,
after which 07 merges into 06, 06 merges into the base with `--merge`, and the base's
green-verify invariant is preserved throughout.
**Status:** done · 2026-08-23

## What ticket 06 measured, which changes this ticket's premise

**ox's anti-slop rules were never running at all** — this is worse than the "wrong
severity" the plan below assumes. ox's nested `.oxlintrc.json` did not extend the root, so
the plugin was **unregistered for ox's whole subtree** and reported **0 findings**. With
the config extending the root it reports **358 at `warn`**.

So the starting count for the ratchet is 358, not zero, and ADR 0051's reasoning — which
covered Biome — does not settle oxlint. Ticket 05 found the same shape in codex, where the
rules ran at `warn` against the root's `error`, and where two configs registering a plugin
named `anti-slop` abort the run outright.

## Goal

Bring ox under the shared lint gate without editing ox source, using one time-limited
override block that shrinks monotonically. Read ADR 0051 first.

## Criteria

1. **The residual is already measured — ticket 07 did it after its reformat.** Biome on ox
   is **16 errors + 4 warnings**, down from 112 + 4, with **zero formatting and zero assist
   findings**:

   | rule | count | severity |
   |---|---|---|
   | `noEmptyBlockStatements` | 9 | error |
   | `noArrayIndexKey` | 4 | error |
   | GritQL `no-bare-size` | 2 | error |
   | `noUnusedVariables` | 1 | error |
   | `noUnusedImports` | 3 | warning |
   | `noBarrelFile` | 1 | warning |

   Anti-slop on ox is **358**, unchanged by the reformat.

2. **The 2 GritQL findings are not warn-tier material — fix them at the source.** ADR 0051
   originally said the plugin was "rescoped to `stacks/claude/admin/**`". It cannot be:
   `plugins` is a top-level repo-wide array, and Biome 2.5.6 supports neither
   `overrides[].plugins` nor suppression comments. The ADR is corrected. **Rewrite the two
   bare-px sites in `stacks/ox-alpha/apps/admin/src/styles.css`**, exactly as ticket 05
   already did for codex's one `margin: -1px` in `.sr-only`. A token-level CSS edit with no
   behavioural effect is not the design work the campaign forbids, and this is bounded at
   two sites.
2. **One `overrides` block in the root `biome.json`, scoped to
   `stacks/ox-alpha/**`**, listing the residual rules at **`warn`**.
   - **`warn`, never `off`.** `off` is invisible; `warn` is a countdown.
   - Expect `useExhaustiveDependencies` and `noBarrelFile` among them, plus whatever the
     recommended rules added in biome 2.3–2.5 report — ox has never been checked by
     them, having pinned `~2.2.0`.
3. **The same shape for oxlint.** ox has never run the anti-slop plugin. Land it at
   `warn` behind path overrides, the policy codex's `AGENTS.md` already describes.
   **Keep exactly one copy of `tools/oxlint/anti-slop`** — claude's and codex's are
   byte-identical, verified at charting time.
4. **Write the ratchet policy down** where a future ticket will read it: a rule moves
   from `warn` to `error` once its count reaches zero, and **every file a ticket touches
   must pass at `error` before that ticket is done.** That is what makes the backlog
   shrink monotonically and leaves no slop by the end of campaign 3.
5. **Confirm the GritQL plugin is scoped to `stacks/claude/admin/**`** (ticket 02
   repointed the path; this confirms the scope). Its header says its file-scoping is
   sound "because the dashboard sheet is the only CSS in the repo" — after fusion there
   are three, and the sibling admins have no `--space-N`/`--text-N`/`--radius-N` scale
   to point at. Rescoping restores exactly the scope the header already assumes.

## Constraints

- **Edit no ox source.** `useExhaustiveDependencies` fixes in a React admin are exactly
  the kind that alter runtime behaviour, which this campaign forbids.
- The override block is one stack, one named rule list, and it is empty by the end of
  campaign 3. Record that expiry in the config comment.

## Done when

`pnpm verify` is green: `biome check` exits 0 with **zero errors anywhere**, residual
`warn` diagnostics on ox source only and from the named list; `pnpm anti:slop` likewise.
The PR body carries the starting per-rule counts, which are the campaign's ratchet
baseline.
