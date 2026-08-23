---
type: note
title: Wayfinder — Monorepo Fusion
description: Campaign map for fusing codex-proxy and ox-alpha-proxy into this repository as one pnpm monorepo.
tags: [wayfinder, monorepo, campaign]
timestamp: 2026-08-23
scope: all
---

# Wayfinder — Monorepo Fusion

**Slug:** `monorepo-fusion`
**Integration branch:** `the-great-merge` (cut from it, merged back into it; the planning and campaign pull requests target it — resolved from `--integration`, not the repository default)
**Base branch:** `wayfinder/monorepo-fusion` (cut from the integration branch above; every ticket targets it)
**Unattended:** `yes` (fixed at start by whether `--unattended` was typed there; `yes` means the kickoff prompt resumes this campaign unattended)
**Plans directory:** `docs/wayfinder`
**Started:** 2026-08-23
**Goal:** Make three repositories one repository that verifies green, with zero behaviour change to any of the three stacks.

> Ephemeral scaffolding, on a schedule. Every `monorepo-fusion-*.md` plan beside this file stays here for
> the campaign's life — marked done once its task lands — so any task can be restarted from what
> was asked. The final ticket `monorepo-fusion-zz` deletes them all; this map goes when the wayfinder
> closes. The durable output is the merged code and the repository's feature and spec docs.

## Scope

**In scope.** One pnpm workspace, one toolchain, one docs bundle, one CI gate.

**Out of scope, and a ticket that touches them is rejected:** the wire contracts, the
storage model, the pricing catalogue, the dashboard. Those are campaigns 2 and 3.
Nothing any of the three stacks does today is deleted.

**The rejection rule and its boundary.** Any ticket that changes runtime behaviour is
rejected. The boundary that decides borderline cases, from ADR 0050:

> A fusion-caused regression is in scope to prevent. Pre-existing awkwardness is out of
> scope to fix.

## Decisions governing this campaign

Written before any ticket was cut. Read these before executing anything — several
correct errors in the original brief.

| ADR | Decision | needs-human |
|---|---|---|
| [0050](../adrs/0050-stack-scoped-environment-variables.md) | Port defaults stay verbatim; env-var names become stack-scoped with a per-package legacy fallback | **yes** |
| [0051](../adrs/0051-absorb-ox-into-the-shared-lint-gate.md) | ox absorbed at a warn tier; its biome delta splits by fixability; the GritQL plugin is rescoped | no |
| [0052](../adrs/0052-inherited-ratification-flags-survive-the-merge.md) | Inherited `needs-human`/`ratified` flags survive unchanged; the backfill covers only claude's 6 unflagged records | **yes** |
| [0053](../adrs/0053-the-merged-corpus-replaces-its-sources.md) | The merged ADR record replaces both sources: **38** inherited records, not 46; new records renumbered 0039–0056 | **yes** |
| [0054](../adrs/0054-each-stack-keeps-its-own-corpus-root.md) | Each stack keeps its corpus at its own stack root; resolvers untouched; migration carries its own evidence | **yes** |
| [0055](../adrs/0055-the-rename-covers-every-non-import-reference.md) | The rename covers every non-import reference, gated by a grep, because pnpm fails open | no |
| [0056](../adrs/0056-the-docs-gate-asserts-indexes-by-file.md) | The docs gate asserts section indexes by file and permits links out to source | no |
| [0057](../adrs/0057-the-filter-gate-covers-invocations-not-records.md) | The filter gate covers executable surfaces, not `docs/adrs/` or `docs/wayfinder/` — a record quoting a broken command is evidence | no |

## Corrections to the brief, established by measurement

Each of these was verified against the three repositories before charting. A ticket
that follows the original brief instead of the correction will do the wrong work.

1. **Ports do not collide the way the brief said.** The three proxies already hold
   `8787`/`8026`/`8807` and both siblings carry comments saying they moved off `8787`
   deliberately. What actually collides: claude's and ox's **servers** (both `8788`),
   all three **admin dev servers** (Vite `5173`), and — created by fusion — the `PORT`
   **variable name** across roles. See ADR 0050.
2. **46 ADRs is a file count, not a record count.** Merging 16 paired records into 8
   yields **38**. See ADR 0053.
3. **"All caught by typecheck" is false for 29 of 184 rename sites.** 155 are
   `.ts`/`.tsx`; the rest are markdown, JSON, YAML and shell. See ADR 0055.
4. **24 colliding top-level paths is an overcount.** 18 collide between claude and
   codex; ox's 16 are a subset.
5. **`git filter-repo` is not installed** on this device. Available via Homebrew 2.47.0.
6. **`.git-blame-ignore-revs` does not exist** in any of the three repos. It must be
   created, and creating it is inert without `git config blame.ignoreRevsFile`, which
   cannot be committed.
7. **Blocker (d) is an anchor mismatch as well as a default mismatch.** codex's server
   resolves `AUDIT_DIR` from `cwd`, its proxy from `import.meta.dirname`.
8. **Blocker (f) needs both halves.** `deploy-concepts.yml` has a stale `paths` filter
   *and* a `pnpm --filter concepts` argument that the rename breaks.
9. **Blocker (h), measured:** codex's `check-docs.mjs` against claude's 62 docs fails
   with exactly 5 errors — 0 broken links, 1 containment violation, 4 index assertions
   that okq's generated format never satisfies. See ADR 0056.

## Residual risks

Noted, not yet ticketed into their own units; each is folded into the ticket named.

1. **~~ox has no `tsconfig.base.json`~~ — settled by ticket 06: it adopted the shared
   base, error count 0.** And adopting it fixed a **real fusion-caused break** rather than
   a naming inconsistency: ox's core set no `skipLibCheck`, so under shared `node_modules`
   `tsc` began checking vite's `.d.ts` and failed with `TS2304: Cannot find name 'Worker'`.
   *(closed)*
15. **ox's anti-slop rules were never running — not merely at the wrong severity.** Its
    nested `.oxlintrc.json` did not extend the root, so the plugin was unregistered for
    ox's whole subtree and reported **0 findings**. Extending the root reports **358 at
    `warn`**. That is the ratchet's real starting count, and it is the second confirmation
    that ADR 0051 settles Biome and not oxlint. *(ticket 08)*
17. **Every branch in the ox stack must merge with `--merge`, not just ticket 06's.**
    Ticket 07's reformat commit `dfff442` is recorded inside `.git-blame-ignore-revs` and is
    reachable only from its own branch — a squash makes the ignore file name a commit that
    exists nowhere, and it then silently does nothing. **Third instance of the squash
    hazard** in this campaign. *(tickets 06, 07, 08)*
18. **`blame.ignoreRevsFile` is per-clone while the file it names is per-branch, and git
    treats a missing ignore list as fatal.** So documenting "set this config" without a
    caveat breaks `git blame` on every branch cut before the file existed. Ticket 07 found
    this by testing rather than assuming, documented it in both `AGENTS.md` and the
    bootstrap script, and deliberately left the config unset in this clone. *(recorded)*
16. **A codex proxy test is flaky under parallel load.** `stacks/codex/proxy`'s
    `proxy.test.ts:596` failed once in five local full-suite runs (`null !== 0`,
    spawned-CLI exit timing), passed 3/3 in isolation before and after, and **24/24 on
    CI**. ox's absorption adds parallel load that plausibly surfaces it. Same class as
    ticket 19. *(candidate ticket; left alone as out-of-lane by ticket 06)*
13. **A sibling ticket must be merged with `--merge`, never `--squash`.** Ticket 05's branch
    carried 50 otherwise-unreachable commits, 44 of them named in the commit map. `/god`
    defaults to squash, which would orphan them and falsify the history bridge
    irreversibly. **Ticket 06 is identical.** *(ticket 06)*
14. **The commit maps are a superset of what was absorbed.** `filter-repo` mapped every ref
    in each fresh clone, but only `main` was absorbed — so 17 of codex's 61 entries name
    commits from abandoned branches that reach nothing in this repository. A reader
    resolving one of those permalinks gets a `new` SHA that exists nowhere.
    `docs/history/index.md` should say which column is authoritative and that non-`main`
    refs were mapped but not absorbed. *(ticket 14)*
2. **The ADR timestamp sort is 29/38 tied** — codex's 16 are all `2026-08-19`, ox's 13 all
   `2026-08-22`. Ties break on the source repo's existing number. *(ticket 12, ADR 0053)*
3. **`.gitattributes` `CHANGELOG.md merge=union` silently widens** to `stacks/*/CHANGELOG.md`,
   whose shape was never checked against the justification. *(ticket 14)*
4. **`packages/shared/` empty is a day-one install hazard** — ox's root script is `pnpm -r
   typecheck` with no `--if-present`. *(ticket 10)*
5. **`the-great-merge` divergence is bounded but not free.** 367 of 510 tracked files
   relocate, under git's 1000 rename limit, but every later `main` → `the-great-merge`
   integration is a rename-crossing merge over the two hottest trees.
6. **`~/Library/LaunchAgents/com.llevasseur.claude-proxy.plist` is already broken** — it runs
   `proxy/proxy.mjs`, a file that does not exist — and is not tracked in git, so no ticket
   reaches it. The human's to fix. *(recorded in ADR 0055)*
7. **This repository has no PR gate, so every ticket so far merged unchecked.**
   Confirmed on PR #266: `gh pr checks` reports *no checks* on the branch, and
   `deploy-concepts.yml` — itself paths-filtered — is the only workflow. Each runner's own
   `pnpm verify` is real, but nothing mechanical would stop a red merge, so ticket 03's
   deliberately-red intermediate state was **unenforced rather than approved**.
   **Closed by ticket 16**: `.github/workflows/verify.yml` is on the campaign base as of
   `1513df6`, so every ticket from 05 onward is gated. Tickets 01–04 remain the four that
   merged unchecked. *(closed)*
8. **The route-budget gate is intermittent, not stale.** Ticket 01 measured it red at
   433ms; ticket 03 measured the same gate green at `12ee731`. It reads recorded
   observations from the shared `logs/` store, so its verdict depends on data outside the
   commit. *(ticket 15, rewritten around this)*
9. **The filter gate reads `git ls-files`, so an untracked file is unchecked until it is
   staged.** Ticket 16 found this while planting a test filter — the plant was invisible
   until staged. Design rather than defect (the gate checks the tree that would ship), but
   worth knowing before trusting it against a working directory. *(no ticket; recorded)*
10. **~~`pnpm test` hangs in CI~~ — solved by ticket 17.** `system-prompt.test.ts` passed
    `/proc/nonexistent-root` as an unwritable directory; on Linux `mkdirSync(recursive)`
    against procfs never returns, and macOS has no `/proc`. *(closed)*
11. **A hang in one package silently skips every package batched after it.**
    `stacks/claude/server`'s tests had **never once run in CI** — pnpm's topological
    batching never got past the batch the hanging proxy sat in, so an entire suite was
    skipped while the job merely looked slow. This is the campaign's second instance of a
    gate reporting something other than what it appeared to: the first was pnpm's
    filter-matching-nothing exiting 0. **Treat a slow CI job as a possibly-truncated one**
    until the per-package test counts are checked. *(ticket 18 owns the resulting
    failures)*
12. **`chat-cli.test.ts` has a wall-clock-sensitive assertion** (`expected 602 to be
    greater than 1000`) that failed once under a loaded local full-suite run and passed 4/4
    in isolation. Flaky under load rather than wrong. *(ticket 18 if the fix is cheap,
    otherwise its own ticket)*

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 19 | chat-cli-idle-window-test | [monorepo-fusion-19-chat-cli-idle-window-test](monorepo-fusion-19-chat-cli-idle-window-test.md) | `task/monorepo-fusion-19-chat-cli-idle-window-test` | todo | Found by ticket 18. Under load the idle clock fires instead of the ceiling the test is about, so the case silently stops testing what it names. Not urgent; independent of 05/06. |
| 20 | ox-history-test-flake | [monorepo-fusion-20-ox-history-test-flake](monorepo-fusion-20-ox-history-test-flake.md) | `task/monorepo-fusion-20-ox-history-test-flake` | in-progress | |
| 09 | migrate-corpora | [monorepo-fusion-09-migrate-corpora](monorepo-fusion-09-migrate-corpora.md) | `task/monorepo-fusion-09-migrate-corpora` | in-progress | |
| 10 | unify-toolchain-and-ci | [monorepo-fusion-10-unify-toolchain-and-ci](monorepo-fusion-10-unify-toolchain-and-ci.md) | `task/monorepo-fusion-10-unify-toolchain-and-ci` | in-progress | |
| 11 | repair-and-wire-docs-gate | [monorepo-fusion-11-repair-and-wire-docs-gate](monorepo-fusion-11-repair-and-wire-docs-gate.md) | `task/monorepo-fusion-11-repair-and-wire-docs-gate` | todo | |
| 12 | merge-adr-corpus | [monorepo-fusion-12-merge-adr-corpus](monorepo-fusion-12-merge-adr-corpus.md) | `task/monorepo-fusion-12-merge-adr-corpus` | todo | |
| 13 | write-campaign-adrs | [monorepo-fusion-13-write-campaign-adrs](monorepo-fusion-13-write-campaign-adrs.md) | `task/monorepo-fusion-13-write-campaign-adrs` | todo | |
| 14 | ports-zellij-and-agents-md | [monorepo-fusion-14-ports-zellij-and-agents-md](monorepo-fusion-14-ports-zellij-and-agents-md.md) | `task/monorepo-fusion-14-ports-zellij-and-agents-md` | todo | |
| 15 | re-record-route-budget | [monorepo-fusion-15-re-record-route-budget](monorepo-fusion-15-re-record-route-budget.md) | `task/monorepo-fusion-15-re-record-route-budget` | todo | Added after ticket 01 found `verify` already red on the untouched base. Must run after ticket 09. |
| zz | retire-done-plans | [monorepo-fusion-zz-retire-done-plans](monorepo-fusion-zz-retire-done-plans.md) | `task/monorepo-fusion-zz-retire-done-plans` | todo | Final ticket — deletes every plan. Execute last. |

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

## Ordering

Tickets 01–06 are strictly ordered and cannot be parallelised: the rename must land
before anything installs (pnpm rejects duplicate unscoped names), and relocation must
strictly precede absorption (read-tree refuses to overwrite existing index entries).

- **01 → 02 → 03 → 04** sequential.
- **05 → 06** sequential, both after 04.
- **07, 08** after 06. 07 before 08 (reformat, then measure the residual).
- **09, 10, 11** after 06; independent of each other by file scope.
- **12, 13, 14** touch only `docs/` and `.zellij/`; independent of 07–11.
- **zz** last, after every other ticket completes.

A gate is a commit on `wayfinder/monorepo-fusion` with a green verify and an honest
map. Every wave boundary above is one.

## Agent kickoff prompt

> Read this repository's agent instructions, the wayfinder workflow, and the campaign
> map at `docs/wayfinder/wayfinder-monorepo-fusion.md`. Inspect live git and worktree
> state rather than trusting any summary.
>
> Before choosing anything, repair stale rows: for each task marked in progress, check
> whether a run is really behind it — a live worktree, a branch pushed within that run's
> lifetime, an open pull request. Leave the ones that have one. For the rest, read the
> branch and rewrite the status: to stopped-by-usage-window where work is in hand, and
> to never-started where there is nothing worth resuming.
>
> Then execute the next unblocked active task by running the task workflow against its
> plan, with `wayfinder/monorepo-fusion` as the base branch, and retarget the resulting
> pull request to that same branch. A task is eligible when it was never started, was
> deliberately paused, was stopped because a usage window ran out and that window has
> since reset, or is marked for redoing differently. Never re-execute a task a human
> rejected — report it and pick another. A task marked in progress belongs to a live run.
>
> The task numbered `zz` deletes this campaign's plan files. Execute it only once it is
> the last active task left; skip it while any other task is active, and never drop it
> from the map or treat it as already done.
>
> If you stop before the pull request is open, set the task's status to say why, with a
> short note, rather than leaving it marked in progress.
>
> This campaign's map records it as unattended, so type the wayfinder workflow's
> `--unattended` flag on the invocation you run. That routes the ticket through the
> merge-through runner, which resolves conflicts, waits for checks, retargets the pull
> request onto `wayfinder/monorepo-fusion`, and merges it there. Do not stop at the open
> pull request — carry the ticket through to merged, never leave it targeting the
> repository default branch, and include the merge in what you report back.

## Completed

<!-- newest first; one entry appended per task completion -->

### 06, 07, 08 — ox absorbed, reformatted, and under the gate · 2026-08-23 · PRs #272, #273, #274

Landed as a stack, 08 → 07 → 06 → base, for the same reason the CI stack did: ticket 06
was complete but red **by design**, and merging it red would have broken the campaign's
own rule that a base commit has a green verify. **Every merge in the chain used `--merge`**
— verified afterwards: **64/64 mapped ox SHAs reachable from the base**, and ticket 07's
reformat commit `dfff442` still reachable, so `.git-blame-ignore-revs` names something
real. **All three stacks are now fused**; `main` untouched at `9b86a61` throughout.

**06 — absorbed.** Four packages scoped to `@agent-proxy/ox-*` across 28 files, ports
unchanged at 8807/8788, `REPOSITORY_ROOT` → `STACK_ROOT`, pins yielded to root, nothing
promoted to `packages/shared/`. **Adopting the shared tsconfig base fixed a real
fusion-caused break rather than a naming inconsistency**: ox's core set no `skipLibCheck`,
so under shared `node_modules` `tsc` began checking vite's `.d.ts` and failed on a missing
`Worker`. Error count after adoption: 0. Unlike codex's, ox's commit map covers exactly
`main`, so all 64 resolve — no superset problem.

**07 — one isolated reformat commit.** 96 files (75 `.ts`, 20 `.tsx`, and one `.mjs` the
plan's "94" did not anticipate), 112 findings down to 16 errors + 4 warnings, zero
formatting and zero assist findings left. **It caught a criterion violation before
committing it**: `biome check --write` also applies safe *lint* fixes, and
`noUnusedImports` has one that **deletes imports** — judgement changes inside a commit
whose whole value is being mechanical. Running with the linter disabled produced exactly
96 fixes for 96 formatter/assist errors, one for one.

**08 — the gate.** ox now reports **0 errors / 18 warnings** and `biome check .` exits 0
repo-wide. One `overrides` block scoped to `stacks/ox-alpha/**` at `warn`, never `off`:
`noEmptyBlockStatements` 9, `noArrayIndexKey` 4, `noUnusedVariables` 1. Ratchet policy
written into `AGENTS.md` rather than a config comment, since `biome.json` is strict JSON —
the same precedent that file already sets for `noNonNullAssertion`. **2190 tests across
eleven packages, zero failures.**

**Findings that corrected the campaign's own records:**

- **ox's anti-slop rules were never running** — its nested config did not extend the root,
  so the plugin was unregistered for ox's whole subtree and reported **0**. Extending it
  reports **358**. Second confirmation that ADR 0051 settles Biome and not oxlint.
- **ADR 0051 asserted something the pinned Biome cannot do.** It said the GritQL plugin was
  "rescoped to `stacks/claude/admin/**`"; `plugins` is a **top-level repo-wide array** and
  the path only says where the plugin file lives. The ADR is corrected, and the three
  sibling bare-px sites were rewritten instead — both ox sites were `border-radius: 999px`
  against an existing `--radius-pill: 999px`, so identical computed values.
- **`blame.ignoreRevsFile` is per-clone while the file is per-branch, and git treats a
  missing ignore list as fatal** — so documenting the config without a caveat breaks
  `git blame` on every branch cut before the file existed. Found by testing; documented in
  both places; left unset here.
- **Two judgement calls worth keeping.** `useExhaustiveDependencies` fires **zero** times
  on ox, so it stayed at `error` — a rule at zero must, under the ratchet. And
  `noUnusedImports`/`noBarrelFile` stayed out of the block because they are already `warn`
  repo-wide; listing them would have faked a ratchet that could never tighten.

### 05 — absorb-codex · 2026-08-23 · PR #271

codex-proxy absorbed under `stacks/codex/` via `--allow-unrelated-histories --no-ff` from
the existing rewrite, never regenerated. Four packages scoped to `@agent-proxy/codex-*`
across 18 files, bins unchanged, ports unchanged at 8026/4319, no `logs/` data touched.
**First ticket in this campaign to merge under a live CI gate** — `verify pass` in 1m47s.

**It was nearly merged in a way that would have destroyed the history it exists to
preserve.** `/god` defaults to squash, and the runner refused to take that silently: the
branch carried **50 commits reachable from nowhere else**, including codex's `Initial
commit`. Verified independently before merging — **44 of the 61 mapped `new` SHAs were
reachable only via that branch**, so a squash would have orphaned all 44 and left
`docs/history/codex-proxy-commit-map.txt` pointing at objects no branch reaches,
falsifying criterion 1 irreversibly once the branch was deleted. Merged with `--merge`;
those 44 are now reachable from the campaign base. **Ticket 06 hits this identically.**

**Verification.** Failure set empty on both base (`df94587`) and branch — identical, no
regression. Per-package CI test counts checked rather than assumed, after the earlier
truncation: `claude/core` 918, `claude/server` 751, `claude/proxy` 91, `concepts` 100,
`codex/core` 41, `codex/server` 25, `codex/proxy` 24 — **1950 total across all seven
test-bearing packages**, matching local, so nothing was skipped. A fresh-clone smoke test
showed the server ingesting a proxy-written sidecar (`recordCount: 1`) with a negative
control under the old `AUDIT_DIR=logs` giving `recordCount: 0` — blocker (d) fixed in both
halves, anchor and default.

**Two findings that contradict the plan:**

1. **"codex needs no warn tier" is true for Biome and false for oxlint.** codex ran all 15
   anti-slop rules at `warn` where the root sets `error`, and two configs registering a
   plugin named `anti-slop` abort the run outright. codex's config now extends the root and
   restates its severities. ADR 0051 reasoned about Biome alone and should not be read as
   covering oxlint.
2. **The GritQL plugin's justifying premise is now false.** Its comment scopes itself with
   "the dashboard sheet is the only CSS in the repo"; this merge breaks that and ox breaks
   it again. One `margin: -1px` in codex's `.sr-only` had to be rewritten because Biome
   2.5.6 supports neither `overrides[].plugins` nor plugin suppression comments. Folded
   into ticket 14 alongside the other `AGENTS.md` corrections.

### 16, 17, 18 — the CI gate and the two defects it immediately found · 2026-08-23 · PRs #268, #269, #270

Landed as one stack — 18 → 17 → 16 → base — because `verify.yml` existed only from ticket
16's branch upward, so each level had to be cut from the branch carrying the interface it
consumed. **No red pull request was merged anywhere in the chain.** `main` and
`the-great-merge` untouched throughout; the campaign base is at `1513df6` and
`.github/workflows/verify.yml` is now on it, so every later ticket inherits CI.

**16 — the gate.** `scripts/check-package-filters.mjs` gained
`UNSCANNED_DIRECTORIES = ['docs/adrs/', 'docs/wayfinder/']` per ADR 0057, with the reason
and citation at the exclusion. Narrower in **where** it looks and identical in **what** it
catches, proven both ways: green over 541 tracked files with **no citation edited**, and
two deliberately planted unscoped filters — in `verify.yml` and `package.json`, two
different in-scope categories — each still failing it at exit 1. `gh pr checks` went from
`no checks reported` to a real verdict.

**17 — the hang, and it was one line of test setup.** `system-prompt.test.ts` passed
`/proc/nonexistent-root` as its stand-in for an unwritable directory. On Linux
`mkdirSync(recursive)` against procfs **never returns** — Node retries a component the
kernel will not create — so the child spun on CPU and `node --test` waited on it forever.
macOS has no `/proc`, so the same call fails instantly and the suite passed **91/91 locally
every time**. Fixed by pointing at a path whose parent is a regular file (`ENOTDIR`
everywhere). CI: 91/91 in 716ms. No forced exit, no `--test-force-exit`, production code
untouched.

Three readings were wrong before the right one, each killed by an experiment rather than
an argument — a 5-for-5 console-output correlation that turned out not to be causal, an
unref'd watchdog that never fired (proving the child never turned its event loop), and
`/proc` showing `state=R, wchan=0` — spinning, not blocked. Only an `fs.appendFileSync`
trace survived the frozen process to name the test.

**Correction to the record:** only **one** file ever hung. `usage-live.test.ts` ran all
four of its tests and exited; `node --test` simply will not finalize while a sibling is
stuck, which is what made it look like two.

**18 — the suite the hang was hiding.** Fixing the proxy revealed that
**`stacks/claude/server`'s tests had never once run in CI**: pnpm's topological batching
never got past the batch the proxy sat in, so an entire suite was skipped while the job
merely looked slow. Three tests failed the first time they ever executed, asserting the CLI
writes nothing to stderr and seeing Node 22's `ExperimentalWarning: SQLite` (Node 26 does
not emit it, so no local run could ever reproduce it).

Fixed with the preferred approach rather than a relaxed assertion: a shared
`cliEnv(overrides)` helper spreading `process.env` with `NODE_NO_WARNINGS: '1'`, inherited
down the whole `pnpm` → `tsx` → CLI chain, so the assertion stays literally
`expect(stderr).toBe('')`. Applied to **all five** spawns, not the three that failed. The
sibling check found a better bug than the one it was looking for: `cli-help.test.ts` folds
`e.stderr` into the string it runs 31 `toContain` assertions against, so a warning would
have been **silently concatenated** into every one of them. Proven still to bite by
planting a stray `console.error` and getting three failures before reverting.

**Deviations and findings, recorded rather than absorbed:**

- **A wrong ADR citation, which originated in this campaign's own ticket text.** ticket
  18's plan said "ADR 0055's whole subject is output that lies" — a loose analogy stated as
  a governing reference. The runner copied it into a `cli-env.ts` comment; `/review` caught
  that 0055 is about the package rename. Dropped rather than replaced, since no ADR covers
  the topic. **This is the second time ADR 0055 has been damaged by a well-meaning edit**,
  after ticket 04's bulk pass rewrote five of its sentences.
- The filter gate reads `git ls-files`, so an untracked file is unchecked until staged.
- `chat-cli.test.ts`'s idle-window case is **ticket 19**, not a flake: under load the idle
  clock fires instead of the ceiling the test is about, so it silently stops testing what
  it names.
- Five pre-existing anti-slop findings were left standing and named rather than silenced.

### 04 — sweep-non-import-references · 2026-08-23 · PR #267

The filter gate went from **152 findings across 44 files to 13**, by migrating references
rather than weakening the gate. Merged at `a382e2b`; `main` and `the-great-merge`
untouched. Failure set base `{check, check:names, test}` → branch `{check, check:names}`,
a strict subset, and **the three `suggestions-cli-json.test.ts` tests are green** exactly
as predicted.

**The launchd requirement caught the job broken live, which is this campaign's strongest
single result.** Triggered as installed, it printed
`No projects matched the filters in "/Users/llevasseur/Documents/ghub/claude-proxy"` while
`launchctl list` reported **exit 0** — ADR 0055's fail-open thesis observed rather than
argued. After unload/edit/reload/start the log grew 40329 → 43878 bytes and recorded
`8 record(s) written, 543 stored`, `archived 2925 files (450 MB)`, and
`re-ingested 2 directories after eviction`. **Work performed, not an exit code** — and the
retention job that bounds the corpus is running again after being silently dead.

Printed operator commands now derive from a `CLAUDE_SERVER_PACKAGE` constant in
`stacks/claude/core/src/workspace-packages.ts`, consumed by `ideas.ts` and
`suggestions-cli.ts`, with the test driving the same constant — so they cannot drift
again. `deploy-concepts.yml` had **both** its `typecheck` and `test` filter arguments
fixed, closing the half ticket 02 left open.

**Two deviations, both disclosed by the runner rather than hidden.**

1. **The 13 residual findings are a lane conflict, not an oversight.** All 13 live in the
   campaign's own scaffolding — plans `04` (7), `03` (4), `02` (1), and this map (1) —
   and each quotes an unscoped filter *as the defect being described*. A plan cannot state
   the problem without spelling it. The runner refused both to edit other tickets' plans
   and to narrow the gate, which was right on both counts. **Settled by ADR 0057**: the
   gate covers executable surfaces and not records. Implemented by **ticket 16**.
2. **The bulk pass regressed ADR 0055, and the runner disclosed it.** Five sentences
   recording *pre-rename measurements* were rewritten as if they described live
   invocations — most damagingly "**104** occurrences of
   `--filter @agent-proxy/claude-server`", when those 104 were the **unscoped** name and
   that count *is* the finding. Neither the gate nor `/review` could see it, because every
   rewrite made the text more conformant. **All five restored to quote the pre-rename
   name**, and ADR 0057 records why a grep must never be pointed at a record: it does not
   protect it, it corrupts it in the direction the gate rewards.

`~/Library/LaunchAgents/com.llevasseur.claude-proxy.plist` is still broken and still
yours — it runs `proxy/proxy.mjs`, which does not exist. Untracked device configuration,
deliberately not fixed.

### 03 — scope-claude-packages · 2026-08-23 · PR #266

Every package scoped to `@agent-proxy/*`, with the lockfile regenerated **inside** the
rename commit `28cb914` rather than after it. Bins were never touched — the rename
anchored on the top-level `"name"` key, so `claude-proxy`'s `bin` entry never matched.
Merged to `wayfinder/monorepo-fusion` at `ce758ee`; `main` and `the-great-merge`
untouched.

The gate is real: `scripts/check-package-filters.mjs` scans `.ts .tsx .js .mjs .cjs .md
.json .yaml .yml .sh .plist` and is **red at 152 findings across 44 files** — `server`
114, `concepts` 33, `admin` 3, `proxy` 2 — including both sites ADR 0055 named as
invisible to every other gate, `scripts/com.llevasseur.claude-proxy.maintain.plist` and
`.github/workflows/deploy-concepts.yml`. **That redness is ticket 04's to clear and the
gate was not weakened to pass**, which is the outcome this ticket wanted.

One wiring detail worth knowing: root `verify` chains a **fixed** six scripts rather than
discovering by prefix, so a standalone `check:names` would never have been picked up. The
gate hangs off `check` — that is what puts it in the chain — and is additionally exposed
as `check:names` so ticket 04 can iterate on it.

**ADR 0055's fail-open thesis was demonstrated rather than argued.** The branch failure
set is `{check, test}`. `check` is the gate, intended. **`test` is a real regression**:
three tests in `stacks/claude/server/test/suggestions-cli-json.test.ts` fail with
`SyntaxError: Unexpected token 'N', "No project"…` because they spawn the CLI through a
filter naming `server`, which after the rename matches nothing — so pnpm prints "No
projects matched the filters" and **exits 0**, and the test parses that sentence as JSON.
Left unfixed here deliberately: the correct fix is ADR 0055 item 3, in ticket 04's files,
and clearing those references turns all three green.

**Two findings that correct the campaign's record.**

The base verify failure set was **empty**, not `{route-budget-gate}`. Measured in the
worktree at `12ee731` before any edit, all six gates passed. Ticket 15 was planned around
a failure that does not reliably fire, and has been rewritten around the real defect —
a gate whose verdict depends on the shared `logs/` store rather than on the commit.

**This repository has no PR gate.** `gh pr checks` reported none on PR #266, the only
workflow being the paths-filtered `deploy-concepts.yml`. Each runner's own `verify` is
real, but nothing mechanical would have stopped a red merge, so this ticket's sanctioned
intermediate redness was **unenforced rather than approved**. Recorded as residual risk 7,
with ticket 10's `verify.yml` half pulled forward to immediately after ticket 04.

### 02 — relocate-claude-stack · 2026-08-23 · PR #265

All four packages moved under `stacks/claude/`. The relocation commit `af700c7` is a
**pure rename — 367 files, every one `R100`, zero insertions and zero deletions** — with
every config repair in following commits, so `git log --follow` and later `main` merges
survive the move. Merged to `wayfinder/monorepo-fusion` at `bb600c0`; `main` and
`the-great-merge` were untouched throughout.

All four root-anchored `biome.json` paths repaired: both `logs` exclusions to `!**/logs`,
the GritQL plugin to `./stacks/claude/admin/lint/no-bare-size.grit`, and the
`noBarrelFile` exemption to `stacks/claude/core/src/index.ts`.

**Two criteria needed no edit and were reported rather than manufactured** —
`tsconfig.base.json` holds no root-anchored path of its own (only the four packages'
`extends` moved), and every root script filter names a package rather than a path. A
ticket that "fixes" both anyway is a ticket that did not look.

**The traversal proof, and a finding that contradicts `AGENTS.md`.** A
`stacks/claude/logs/` was built with invalid UTF-8 at top level and three levels deep,
plus a mode-`000` directory as a binary traversal signal. With no exclusion, biome
emitted both UTF-8 errors and `Permission denied (os error 13)` — traversal directly
observable. With `!**/logs` it emitted neither, checking 364 files in 51ms.

But the honest finding is that **on Biome 2.5.6 the weak `!logs/**` form also prunes**, so
the distinction `AGENTS.md` records as load-bearing **no longer discriminates on this
version**. The strong form was kept as documented-to-prune and measurably faster.
`AGENTS.md` needs correcting rather than copying forward — **folded into ticket 14**.

**Comparing the verify failure set rather than checking for non-emptiness caught two real
regressions** that a "still red, as expected" check would have shipped: a `core` test
importing `../../../proxy/session.ts`, which after the move resolved to `stacks/proxy/`,
and two server tests anchoring two levels up from `server/test/`, which is now the stack
root. Base `{route-budget-gate}` → branch `{}`, a strict subset.

**Lane extensions, disclosed rather than absorbed:** `pnpm-lock.yaml` (inseparable from
the workspace-glob change), `CHANGELOG.md` (repo convention; `merge=union` exists so
parallel tickets cannot collide there), and the four regression fixes above — of which
`core/src/fallbacks.ts` is arguably ticket 04's. `scripts/bootstrap-worktree.sh` still
links `apps/admin/.env` and `proxy/.env` and was deliberately left alone, since ADR 0054
assigns it to ticket 09.

**Two things left for the human**, neither blocking the remaining tickets:
`server/.env` is stranded at the old path and needs to become `stacks/claude/server/.env`
(never read, moved, or deleted by any run here), and the main checkout wants a
`pnpm install` to clear stale `node_modules` under the old `apps/`, `packages/`, `proxy/`
and `server/` directories.

### 01 — rewrite-sibling-histories · 2026-08-23 · PR #264

Installed `git-filter-repo` 2.47.0 via Homebrew (it was not on the device), cloned both
siblings fresh outside this repository, and rewrote each with
`--to-subdirectory-filter` alone — no `--force`, no `--refs`. **61 codex-proxy and 64
ox-alpha-proxy commits mapped, none dropped.** The working checkouts were never touched.

Added `docs/history/{codex-proxy,ox-alpha-proxy}-commit-map.txt` and
`docs/history/index.md`. After the sibling repositories are archived these maps are the
only way to resolve an existing permalink.

**The rewritten clones are left in place and must not be deleted or regenerated** —
tickets 05 and 06 absorb these exact clones, and a re-run would produce different SHAs
and invalidate the committed maps:

- `~/Documents/ghub/monorepo-fusion-rewrites/codex-proxy` → `stacks/codex`
- `~/Documents/ghub/monorepo-fusion-rewrites/ox-alpha-proxy` → `stacks/ox-alpha`

**Deviations from the plan, all three disclosed rather than absorbed:**

1. **`pnpm verify` was not fully green, and the cause is pre-existing.**
   `server/test/route-budget-gate.test.ts` fails on `/api/commands` at a 433ms median
   against a 390ms allowance, reading recorded observations out of the shared `logs/`
   store. It fails identically on the untouched base, and this ticket added only
   documentation. Re-recording the budget means editing `server/`, outside this ticket's
   lane. **This is now ticket 15** — every other ticket's done-condition asks for a green
   `verify`, so left unfixed it would have been inherited by all of them and the
   campaign could never report green.
2. **`AGENTS.md` enumerates the docs bundle's folders and now omits `history/`.** Outside
   this ticket's lane; folded into ticket 14, which already merges `AGENTS.md`.
3. **A precondition judgement call, since verified.** codex-proxy showed five local-only
   commits, which the plan says to stop on. Checked independently: `main` is
   byte-identical to `origin/main` at `ca20e0e` with **zero** local-only commits
   reachable from it. The five sit on six abandoned branches whose upstreams are `gone`
   — squash-merged PRs, so their content is already in `main` — plus two stash entries.
   A fresh clone never sees them. **The call was right and the maps stand.**
