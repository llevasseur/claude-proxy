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
| [0053](../adrs/0053-the-merged-corpus-replaces-its-sources.md) | The merged ADR record replaces both sources: **38** inherited records, not 46; campaign records numbered above them | **yes** |
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
8. **~~The route-budget gate is intermittent~~ — WRONG, and ticket 15 measured why.** It was
   never flaky. As `pnpm verify` runs it the gate reported **`no observations for 50`** — all
   fifty budgeted routes, zero observations — so **ten green runs were vacuous**. Pointed at
   the real store it failed 10 of 10, byte-identical. Ticket 01's red and ticket 03's green
   were **two different data sources**: the relocation landed between them and changed what
   `resolveLogDir()` returns. *(closed by ticket 15)*
21. **The route-budget gate is STILL reading nothing, and stays that way until ticket 09.**
    It now resolves `stacks/claude/logs`, which exists in no checkout, while the store is
    still at the repository root. Ticket 15's minimum-sample-count fix was chosen precisely so
    it survives the move — but until ticket 09 relocates the corpus, that gate contributes no
    evidence to a green `verify`. **Do not read this gate's pass as a measurement.**
    *(ticket 09)*
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

19. **codex is on an anti-slop warn tier that no record covers.**
    `stacks/codex/.oxlintrc.json` restates all 15 rules at `warn` where the root sets
    `error`. ADR 0051 designs a tier for **ox alone** — with a count, a ratchet and an
    expiry — and codex has the severities without any of that. The campaign reasoned from
    the opposite premise for several tickets: ticket 05's "restates its severities" was read
    as *restoring* root severity, and ticket 21's dispatch asserted outright that codex was
    not on a tier. **A silent tier looks identical to compliance and never shrinks.**
    *(ticket 24)*
20. **Two more live flakes, in lanes no ticket owns yet.** Ticket 21's whole-repo loop failed
    **3 of 10** runs on `stacks/claude/server` and ox's admin — separate from the ox history
    flake (ticket 20) and the codex proxy flake (ticket 21), both now fixed. This campaign
    keeps surfacing flakes because before ticket 16 there was no CI to surface them.
    *(candidate ticket)*

## Active tasks

| # | Task | Plan | Branch | Status | Note |
|---|------|------|--------|--------|------|
| 19 | chat-cli-idle-window-test | [monorepo-fusion-19-chat-cli-idle-window-test](monorepo-fusion-19-chat-cli-idle-window-test.md) | `task/monorepo-fusion-19-chat-cli-idle-window-test` | todo | Found by ticket 18. Under load the idle clock fires instead of the ceiling the test is about, so the case silently stops testing what it names. Not urgent; independent of 05/06. |
| 09 | migrate-corpora | [monorepo-fusion-09-migrate-corpora](monorepo-fusion-09-migrate-corpora.md) | `task/monorepo-fusion-09-migrate-corpora` | paused | Stopped before the `mv`, deliberately: all three corpora have live proxy+server writers with open WAL-mode SQLite connections, so the move risks the corpus and criterion 3 (before == after) is unassertable while claude gains ~21 files/45s. Needs a human to ratify ADR 0054, authorise quiescing the three stacks, and pick a byte measure (`du -sb` is GNU-only; this device has BSD `du`). Criterion 6 and the STACK_ROOT rename already satisfied by tickets 05/06. |
| 23 | retire-stale-stack-agents-files | [monorepo-fusion-23-retire-the-stale-stack-agents-files](monorepo-fusion-23-retire-the-stale-stack-agents-files.md) | `task/monorepo-fusion-23-retire-the-stale-stack-agents-files` | todo | Ticket 14 merged the three AGENTS.md into one but `git rm` of the two stack copies was refused twice by the classifier; it correctly refused to empty them instead. Also carries two dangling references ticket 14 disclosed. |
| 24 | decide-codex-oxlint-severities | [monorepo-fusion-24-decide-codex-oxlint-severities](monorepo-fusion-24-decide-codex-oxlint-severities.md) | `task/monorepo-fusion-24-decide-codex-oxlint-severities` | todo | Found by ticket 21: codex restates all 15 anti-slop rules at `warn` where the root sets `error`. ADR 0051 designs a warn tier for **ox alone**, so codex is on an undocumented one. |
| 11 | repair-and-wire-docs-gate | [monorepo-fusion-11-repair-and-wire-docs-gate](monorepo-fusion-11-repair-and-wire-docs-gate.md) | `task/monorepo-fusion-11-repair-and-wire-docs-gate` | todo | |
| 25 | retire-sibling-docs-trees | [monorepo-fusion-25-retire-the-sibling-docs-trees](monorepo-fusion-25-retire-the-sibling-docs-trees.md) | `task/monorepo-fusion-25-retire-the-sibling-docs-trees` | todo | **A charting gap, not a slipped ticket.** `stacks/{codex,ox-alpha}/docs/{adrs,features,roadmap,specs}` were never merged into the root bundle. While the sibling `adrs/` stand, each of the eight shared decisions is stated in more than one live file — the contradiction ox ADR 0010 warned of, and a direct violation of ADR 0053. |
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

### 13 — write-campaign-adrs · 2026-08-24 · PR #282

Eleven records at **0039–0049**, every one `ratified: true`, `scope: all`, carrying a
`provenance` field naming the campaign, and **none carrying `needs-human`** — written as
records of decisions already taken rather than re-opened.

**It re-derived the numbering against the directory rather than trusting the plan or my
dispatch.** Both said 0039–0049; it read `docs/adrs/` first, confirmed those eleven slots were
genuinely free between the 38 inherited records and the campaign's own at 0050+, and only then
wrote. The range was right, but it was checked rather than assumed — which is the correct
order given I had just told it my own numbers might be stale.

The load-bearing content survived at full strength. **0039** supersedes **0022** and **0023**,
resolved through `legacy-map.md` and cited by their post-merge numbers, with the reasoning
stated outright: parity with a repository is a category error once that repository is a
directory. **0040** says "codex/ox" names shared repo lineage and nothing else, forbids
inferring harness from provider or provider from harness, and requires two independent columns
and two independent registries **with no combined enum**. **0044** keeps cost **null, never
0**. **0047** rests on evidence — `request_skim` is derived before eviction and is
forward-only, so a rebuild deletes irreproducible data while reporting success.

`okq --bundle docs validate` was **byte-identical at base and after**, with zero findings under
`adrs/` on both sides. `ratified=true` went 7 → 18.

**Two follow-ups its reviewer raised, both traceable to me, both now owned:**

1. **Supersession is discoverable only forward.** No `superseded-by` key exists anywhere in the
   corpus, so a reader arriving at 0022, 0023 or 0028 has no way to learn 0039 replaced them —
   they read as current. **Folded into ticket 11**, which adds the key and asserts supersession
   is **bidirectional**, since a one-way link is what produced this.
2. **ADR 0053's forward projection was stale** — it claimed "56 records total" and a range
   ending at 0056; the corpus holds 57 and runs to 0057. **Its load-bearing arithmetic is
   unaffected**: the inherited count of 38 is what that record exists to establish and it held
   exactly. Only the projected total was wrong, and the ADR now states a shape instead, for the
   same reason ADR 0052 stopped quoting a count.

### 15 — re-record-route-budget · 2026-08-24 · PR #281

**The gate was never flaky. It was reading nothing, and ten green runs were vacuous.**
Criterion 1 turned out to be the entire ticket, and the answer was neither of the two things
the prior tickets reported. Ten runs in each of two configurations:

- **As `pnpm verify` actually runs it (no `LOG_DIR`): 10 pass, 0 fail** — with every run
  printing **`no observations for 50`**. All fifty budgeted routes, zero observations.
- **With `LOG_DIR` at the real store: 0 pass, 10 fail**, byte-identical each time —
  `/api/commands (time) median 433ms over 1 observations exceeds its allowance of 390ms`.

**That reconciles the contradiction rather than splitting it.** Ticket 01's red and ticket
03's green were **two different data sources**, not two samples of a coin-flip: the stack
relocation landed between them and changed what `resolveLogDir()` returns. Ticket 01 read the
repo-root `logs/` the bootstrap links; everything after it reads `stacks/claude/logs`, which
exists in no checkout.

**The fix makes the verdict independent of the store without pinning a path** — a
`MINIMUM_OBSERVATIONS` threshold of 5 before a median counts as evidence, with anything short
reported under a new `insufficient` list. The 433ms figure was a median over **one**
observation; the store holds 272 across 10 routes with six at n≤2, and every route with real
samples sits well inside its allowance (`/api/health` 14ms against 259.5 over 206 samples).
**Time half only** — a max over sizes has no noise to out-vote, so one oversized response
still fails on a single request. The threshold was chosen over a fixture specifically so it
survives ticket 09's move.

**No allowance moved.** `headroom`, both floors and all 50 recorded numbers untouched;
`route-budgets.json` is not in the diff. Criterion 2 was correctly not triggered, and the PR
body says outright that criterion 4's before/after table is absent **because nothing
changed**, rather than leaving a reviewer to read the gap as an omission. Re-recording would
have replaced a 490-observation corpus with a 272-observation one from a single cold start —
strictly worse data.

`route-budgets.test.ts` went 18 → 23 tests. Base and branch failure sets both empty, measured
in the same worktree by stashing. CI green first try.

**Recorded as residual risk 21: the gate still reads nothing until ticket 09 lands.** Its pass
is not currently a measurement.

### 12 — merge-adr-corpus · 2026-08-24 · PR #280

`docs/adrs/` holds **38 inherited records at 0001–0038**, verified on the base. Numbering is
timestamp → source repo's existing number → repo, and **the tiebreak was load-bearing exactly
as ADR 0053 predicted**: codex's 16 are all `2026-08-19` and ox's 13 all `2026-08-22`, so
**29 of 38 were tied on date alone** and the numbering would not have been reproducible
without it. All 17 claude records kept their numbers. Every record carries `scope` and
`provenance`.

The eight merged records sit at 0018–0025, **rewritten rather than imported** — 0021 states
codex's five rungs and ox's four as **two scoped instantiations** rather than flattening them
into a contradiction, which is what the `scope` field is for. `legacy-map.md` is new and
many-to-one, and the supersession-versus-merge distinction is written into both it and
`docs/adrs/index.md`.

**ADR 0052 held exactly.** The backfill reached **exactly 6** records — claude 0001–0006,
which carried no ratification fields at all. 0007–0017 keep `ratified: false` and
`needs-human: true`, untouched. Where a merged pair's sources disagreed the runner took the
**union**, so no merge can clear a flag, and an absent flag stays absent rather than being
written as `false`. That rule was its own judgement, not something the plan specified, and it
is the right one.

It also found that **`legacy-map.md` was quoting the literal `needs-human` pattern in prose
and poisoning the repo's own grep by one file**, and reworded it.

**Two corrections came out of it.**

1. **ADR 0052's stated count of 31 was wrong after the merge** — it was written against the
   three source repositories' files. The correct figure is 29 inherited + 4 from this campaign
   = **33**. The ADR is amended to stop quoting a fixed number at all: a campaign that merges
   records changes the count by construction, and an ADR asserting a total invites a later
   reader to "fix" the corpus until it matches.
2. **`stacks/{codex,ox-alpha}/docs/` were never charted for merging** — `adrs/`, `features/`,
   `roadmap/` and `specs/` are all still in place. While the sibling `adrs/` stand, each of the
   eight shared decisions is stated in more than one live file, which is a direct violation of
   ADR 0053 and the contradiction ox ADR 0010 warned about. **Ticket 25**, and it is a gap in
   my charting rather than a ticket that slipped.

The runner also edited `CHANGELOG.md` outside its literal lane, judged it in-bounds, and was
vindicated mid-run: GitHub reported the PR `CONFLICTING` there, `/mc` merged the base in, and
git's `merge=union` driver resolved it with no hand-editing — which is exactly why that
`.gitattributes` line exists.

### 22 — finish-adr-0050-scoped-names · 2026-08-24 · PR #279

**All six of ADR 0050's scoped names now exist in source**, verified on the base:
`CLAUDE_PROXY_PORT`, `CLAUDE_SERVER_PORT`, `CODEX_PROXY_PORT`, `CODEX_SERVER_PORT`,
`OX_PROXY_PORT`, `OX_SERVER_PORT`. Each keeps its bare name as a package-scoped fallback, no
default port changed (8787 / 8788 / 8026 verified as unchanged literals), and codex's proxy
takes ox's proxy shape verbatim so the convention stays one convention.

**The deviation is the interesting part, and it is the campaign's rejection rule applied
correctly rather than waved at.** claude's proxy and server **had no config module at all** —
each read the port inline, and neither has ever validated it, so `Number()` of a bad value
yields `NaN`. Adopting the siblings' range check would have turned a launch that works today
into one that **throws**. So claude's two take the siblings' *resolution order* and leave the
parsing alone. That is why claude gets three config-test cases and codex's proxy four, the
fourth asserting the error names the variable the operator actually set.

It also noticed that a new config module is **dead code without a wiring line at the entry
point**, and added both.

Base measured on its own untouched cut — empty failure set, seven gates — and identical
after. Per-package counts read off the runners: claude-proxy 94, codex-proxy 29,
claude-server 754 across 71 files. Zero anti-slop findings on any touched file. CI green
first try, no repair rounds, `/review` no findings.

**Out-of-lane follow-up, correctly left:** `AGENTS.md`'s Ports section and
`.zellij/README.md` still say these three names are missing and that ticket 22 will
implement them. Both are now false. **Folded into ticket 23.**

### 14 — ports-zellij-and-agents-md · 2026-08-23 · PR #278

Merged at `ee72f2f`. Nine port defaults recorded in a new `.zellij/README.md` with the
variable each reads and the file each is written in — **no number changed**. `AGENTS.md`
merged to one file, with `history/` added to the docs-bundle list, the `!logs` note rewritten
to say both forms prune on Biome 2.5.6 **and to name that version**, and the GritQL plugin's
false premise left standing rather than defended. `docs/history/index.md` now names the
authoritative column and gives the 17-of-61 codex figure against ox's 64 that all resolve.

**Consolidating the layouts repaired broken scripts.** Each stack's `zellij.sh` post-fusion
`cd`s to the monorepo root and looks for `.zellij/<stack>.kdl` there, so moving them fixed
scripts that were silently failing rather than merely tidying.

**This ticket ran twice.** The first attempt stalled on an infrastructure fault — the one
retry `/manage` allows, spent on a cause a retry can actually change. Its discovery survived
and was written into the plan so the retry started from measurement rather than repeating it.

**Three corrections came out of it, two of them to this campaign's own instructions:**

1. **Only three of ADR 0050's six scoped names exist.** `OX_PROXY_PORT`, `OX_SERVER_PORT`
   and `CODEX_SERVER_PORT` landed with tickets 05 and 06 — the absorption tickets, each of
   which scoped its own stack on the way in. **claude never had an equivalent ticket** (02
   relocated it, 03 renamed its packages, neither owned its runtime configuration), and
   codex's proxy was missed. `AGENTS.md` documents what exists and names the three pending.
   **Ticket 22** implements them.
2. **Residual risk 3 has no subject.** `git check-attr` confirms the unanchored
   `merge=union` already resolves for three sibling changelog paths, **none of which exist**.
   Real in mechanism, empty in practice, and now recorded as such.
3. **The "2190 tests across eleven packages" figure I had been handing every ticket was
   stale.** Nine packages carry test scripts, and the base is green on all seven gates.
   Repeating a fixed number across a campaign that keeps moving packages made tickets
   reconcile against my arithmetic instead of measuring their own base. **Stop quoting it;
   tell tickets to compare failure sets against the base they measure.**

**Two things it correctly refused or disclosed.** `git rm` of the two stale stack `AGENTS.md`
files was refused twice by the classifier, and the runner declined to empty them to reach the
same end by another route — the right call, and **ticket 23** owns it. And it widened its lane
slightly to move the stack `.zellij` layouts, said so, and named the two dangling references
that left behind rather than reaching outside to fix them.

### 21 — codex-proxy-test-flake · 2026-08-23 · PR #277

**The proxy announced it was ready before it could be shut down.** `startProxy()` publishes
readiness itself — `ready` to the status file, `proxy-ready` to stdout — but `main()`
registered `SIGINT`/`SIGTERM` only *after* awaiting it. Any supervisor that reads
`proxy-ready` as "the process is up" and signals at once races that gap, and when the OS
deschedules the child inside it SIGTERM meets its **default disposition** and kills the
proxy outright. Node's `exit` yields `[null, 'SIGTERM']` in exactly that case, which
`proxy.test.ts:596` could only report as `null !== 0`. Not a timeout to raise, and not a
test-only defect.

`main()` now takes the start promise first and registers against it, so the handlers land
in the same tick as the call — `startProxy` runs only to its first `await` before control
returns — and therefore before any announcement exists. **No retry, sleep, or raised
timeout was added; one was removed**, the 100-attempt poll for the `shutdown` status, which
a graceful exit already implies. Behaviour after readiness is unchanged.

**Rates.** A probe replicating the test's spawn/`proxy-ready`/SIGTERM/exit sequence against
the real `src/proxy.ts` under 12 CPU burners went from **17/200 to 0/200**, every failure
carrying `code: null, signal: 'SIGTERM'` with the status file still at `ready` — the exact
signature ticket 06 recorded. Prior evidence was 3 in 10 across tickets 06 and 20.

**Two honest limits, both recorded rather than smoothed over.** The suite-level rate does
**not** reproduce here: 40 runs of the codex proxy suite under the same load produced 0
failures against the *unfixed* code, so that denominator proves nothing and is reported
only for symmetry — ticket 20's wall again, and the reason the rate is measured on the
mechanism rather than claimed from a green suite. And the whole-repo 10-run loop failed 3
times without ever touching this flake: every failure was in `stacks/claude/server` or ox's
admin, other lanes entirely, while codex's proxy suite passed 10/10. The new regression
test is deterministic in the fixed direction but cannot fail against the unfixed code,
because a deterministic *process-level* test is not constructible — with the fix the
handlers exist before the process emits anything observable, which is exactly why it works.

**Correction to the ticket brief:** it asserts codex is not under a warn tier.
`stacks/codex/.oxlintrc.json` restates all 15 anti-slop rules at `warn` where the root sets
`error`. The ratchet was met regardless — both touched files report zero findings, cleared
with `SAFETY:` notes and stated-reason disables only.

### 20 — ox-history-test-flake · 2026-08-23 · PR #276

**A real shared-state defect, not timing.** `SidecarIngestor.reconcile()` in
`stacks/ox-alpha/server/src/ingest.ts` coalesced every call onto one `activeReconcile`
promise — and a scan already in flight took its directory listing **when it started**. So a
caller that wrote a sidecar and then awaited `reconcile()` could be handed a listing
predating its own write, and see `changed: false` for a change it had just made. The
watcher starts those scans itself, so no caller could tell a covering scan from a preceding
one, and load decided which assertion lost. **One cause, two symptoms** — the SSE test's
`data-version` frame never arrived; the pagination test saw `total: 3` instead of `4`.

`reconcile()` now queues one trailing scan rather than aliasing the running one, and
`close()` drains both. **No retry, sleep, or raised timeout was added — one was removed:**
`history.test.ts`'s 50-attempt poll loop, whose own comment named this race, is now a single
`await service.reconcile()`.

**Both rates, as the plan demanded.** Probe against the real ingestor: **50/50 raced → 0/50**.
CI, same denominator as the original report: **2/5 before → 0/5 after**, re-run four times on
the identical commit. A new regression test in `ingest.test.ts` fails deterministically
against the old ingestor and passes against the new one; suite 49 → 50.

**It reported a shortfall rather than hiding it.** Criterion 1 wanted local reproduction
under load, and this machine cannot reproduce it — macOS FSEvents against CI's Linux
inotify. Two loops (ox alone ×29, whole-repo ×9) produced **zero** failures *before* the fix,
so it stopped the inconclusive loop rather than letting it run to a meaningless `0/25`, and
moved the measurement to the mechanism and to CI. That limitation is stated in the PR body.

It also **reverted** a `no-array-sort` fix on finding `toSorted()` needs `lib: es2023` while
ox targets `es2022`, and left eight `no-await-in-loop` warnings standing because those awaits
are sequential on purpose. All three touched files pass at `error` under both Biome and
anti-slop — the ratchet's first payment.

**New finding:** codex has its own flake, unrelated — 2 of 9 local whole-repo runs. With
ticket 06's earlier 1-in-5, that is 3 in 10 across two tickets. **Promoted to ticket 21.**

### 10 — unify-toolchain-and-ci · 2026-08-23 · PR #275

Merged at `ed2e9d4`. **Nine of twelve criteria were already true when the ticket opened,
and each was inspected and left alone rather than rewritten to manufacture a diff** —
including the whole of tickets 16's and 08's work. That restraint is the result worth
recording.

**Implemented:** `.editorconfig` — `biome.json` had set `useEditorconfig: true` all along
against a file that existed in **none of the three fused repositories**; `files.ignoreUnknown:
true`, since the merged tree now holds `.kdl`, `.sql`, `.grit` and `.plist`; and
`packages/shared/` with a README saying what it is for and that this campaign promotes
nothing into it.

**Criterion 10 is a correction, not a completion.** The plan said to drop
`scripts/run-if-present.mjs`. The root copy is already gone — but
**`stacks/codex/scripts/run-if-present.mjs` must stay**: three codex manifests reference it
through `../scripts/`, and `pnpm-workspace.yaml` records that codex was deliberately left
unflattened so those paths resolve. Deleting it breaks three codex packages. The plan's
"Done when" said the file would be gone; it is not, for a good reason, and both are
corrected.

**Residual risk 4 was real but not where the plan predicted.** The root scripts already
pass `--if-present`, so `pnpm verify` was never exposed. What was exposed is
`stacks/ox-alpha/package.json`'s bare `pnpm -r typecheck`, inherited from ox's own
repository — and `pnpm -r` resolves against the **root** workspace, so it reaches the new
package. An empty `packages/shared/` would have broken a command that worked before the
merge, which is a fusion-caused regression. Fixed **in lane** with three `exit 0` scripts on
`packages/shared/` rather than editing `stacks/ox-alpha/`.

**Evidence.** A genuine fresh clone at `/tmp/t10-freshclone` — no `node_modules`, no `.env`,
no `logs/` — with `pnpm install --frozen-lockfile` exit 0 and `pnpm verify` exit 0 across all
five gates. Failure sets compared rather than counted: empty on base and branch, identical.
**2190 tests across eleven packages**, matching on base, branch, fresh clone and CI —
claude 91/918/751, codex 24/41/25, ox 28/113/49/50, concepts 100. The ox `history.test.ts`
flake did not fire in any of three local runs or on CI.

**Deferred, correctly:** `check:docs` stays unwired and `check` untouched, gated on ticket
11 — wiring it now would put claude's 62 never-link-checked docs in front of a gate that has
never seen them.

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
