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

1. **ox has no `tsconfig.base.json`**, so blocker (g) does not reach it — four standalone
   configs with no `extends` to repoint, and no severity tier available since tsconfig
   has none. *(ticket 06)*
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
   **Pull ticket 10's `verify.yml` half forward to immediately after ticket 04**, which is
   the first point the tree is green again — landing it earlier would block ticket 04's
   own merge on the redness ticket 04 exists to clear. *(ticket 10)*
8. **The route-budget gate is intermittent, not stale.** Ticket 01 measured it red at
   433ms; ticket 03 measured the same gate green at `12ee731`. It reads recorded
   observations from the shared `logs/` store, so its verdict depends on data outside the
   commit. *(ticket 15, rewritten around this)*

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 04 | sweep-non-import-references | [monorepo-fusion-04-sweep-non-import-references](monorepo-fusion-04-sweep-non-import-references.md) | `task/monorepo-fusion-04-sweep-non-import-references` | todo | |
| 05 | absorb-codex | [monorepo-fusion-05-absorb-codex](monorepo-fusion-05-absorb-codex.md) | `task/monorepo-fusion-05-absorb-codex` | todo | |
| 06 | absorb-ox | [monorepo-fusion-06-absorb-ox](monorepo-fusion-06-absorb-ox.md) | `task/monorepo-fusion-06-absorb-ox` | todo | |
| 07 | reformat-ox | [monorepo-fusion-07-reformat-ox](monorepo-fusion-07-reformat-ox.md) | `task/monorepo-fusion-07-reformat-ox` | todo | |
| 08 | ox-lint-warn-tier | [monorepo-fusion-08-ox-lint-warn-tier](monorepo-fusion-08-ox-lint-warn-tier.md) | `task/monorepo-fusion-08-ox-lint-warn-tier` | todo | |
| 09 | migrate-corpora | [monorepo-fusion-09-migrate-corpora](monorepo-fusion-09-migrate-corpora.md) | `task/monorepo-fusion-09-migrate-corpora` | todo | |
| 10 | unify-toolchain-and-ci | [monorepo-fusion-10-unify-toolchain-and-ci](monorepo-fusion-10-unify-toolchain-and-ci.md) | `task/monorepo-fusion-10-unify-toolchain-and-ci` | todo | |
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
