# monorepo-fusion-07 — Reformat ox to the repository's Biome settings

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-07-reformat-ox`
**Cut from and merged into:** `task/monorepo-fusion-06-absorb-ox` — **not** the campaign
base. Second in a stack: 08 → 07 → 06 → base. Ticket 06 is complete and reviewed but red
**by design** (ox formatting and `noEmptyBlockStatements`), and merging it red would break
the campaign's own rule that a gate commit on the base has a green verify. Stacking keeps
that rule true and merges nothing red, the same shape the 16 ← 17 ← 18 CI stack used.
**When ticket 06's PR #272 finally merges it MUST use `--merge`, never `--squash`** — all
64 mapped ox SHAs are reachable only via that branch.
**Status:** done · 2026-08-23

## Goal

One isolated, mechanical commit that fixes everything biome can fix on ox source without
judgement, and make `git blame` survive it.

## Criteria

1. **One commit, `biome check --write` on `stacks/ox-alpha/` only.** Per ADR 0051 this
   commit covers **everything auto-fixable**, which is wider than the brief's
   "double to single quotes, 100 to 120 columns":
   - quote style, double → single
   - line width, 100 → 120
   - **`organizeImports`** — the assist action. It fails `biome check`, and the
     quote/column reformat does not touch it, so it belongs here rather than in the warn
     tier. Widening the commit to "everything biome fixes without judgement" is the
     honest version of what it already claims to be.
2. **Nothing else in the commit.** No lint fixes, no logic, no renames. 94 `.ts`/`.tsx`
   files are in scope.
3. **Create `.git-blame-ignore-revs`.** It **does not exist in any of the three
   repositories** — the brief says the commit is "added to" it, but the file must be
   created. Add this commit's SHA with a comment naming what it was.
4. **Document the config, because it cannot be committed.** A `.git-blame-ignore-revs`
   file is inert until `git config blame.ignoreRevsFile .git-blame-ignore-revs` is set,
   and git config is per-clone and not committable. So:
   - Add the one-line command to `AGENTS.md` and to the worktree bootstrap script, so a
     fresh clone picks it up.
   - Without this, the reformat commit poisons `git blame` for all 94 files and the
     ignore file silently does nothing.

## Constraints

- **This is not a design act.** Reformatting ox's admin to the repository's Biome
  settings is mechanical. Promote nothing, restyle nothing, and do not dispatch a design
  subagent.
- Formatting is **not** deferred to the warn tier. Only judgement findings are, and those
  are ticket 08.

## Done when

`biome format` reports ox conformant, `biome check` reports **zero formatting and zero
assist findings** on ox (residual linter findings are expected and belong to ticket 08),
`.git-blame-ignore-revs` exists carrying this commit, and the blame config is documented
in both `AGENTS.md` and the bootstrap script.
