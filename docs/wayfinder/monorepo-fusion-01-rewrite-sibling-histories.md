# monorepo-fusion-01 — Rewrite the sibling histories into subdirectories

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-01-rewrite-sibling-histories`
**Status:** done · 2026-08-23

## Goal

Produce two rewritten histories ready to absorb, and commit the two commit-map files
that are the only bridge from the sibling repositories' permalinks once those repos are
archived. This ticket changes no code in this repository.

## Criteria

1. **Install `git-filter-repo`.** It is not present on this device;
   `brew install git-filter-repo` provides 2.47.0. Record the installed version.
2. **Clone both siblings fresh.** `git clone https://github.com/llevasseur/codex-proxy`
   and `.../ox-alpha-proxy` into a scratch directory outside this repository.
   `filter-repo` requires a fresh clone and refuses otherwise — do not point it at the
   working checkouts at `~/Documents/ghub/{codex,ox-alpha}-proxy`.
3. **Rewrite each with `git filter-repo --to-subdirectory-filter stacks/<name>`**,
   where `<name>` is `codex` and `ox-alpha` respectively. **Never pass `--force` and
   never pass `--refs`** — both defeat the safety checks that make the rewrite
   reproducible.
4. **Commit both commit-map files to `docs/history/`** as
   `docs/history/codex-proxy-commit-map.txt` and
   `docs/history/ox-alpha-proxy-commit-map.txt`. `filter-repo` writes them to
   `.git/filter-repo/commit-map` in each rewritten clone. These are the only mapping
   from the old SHAs to the new ones, and after the source repositories are archived
   they are the only way to resolve an existing permalink.
5. **Add `docs/history/index.md`** explaining what the maps are, that the left column is
   the pre-rewrite SHA and the right the post-rewrite SHA, and that a right column of
   all zeros means the commit was dropped.
6. **Leave the rewritten clones in place** at a path recorded in the ticket's PR body.
   Tickets 05 and 06 absorb them; re-running `filter-repo` later would produce different
   SHAs and invalidate the committed maps.

## Constraints

- Both siblings are fully pushed with nothing unpushed, verified at charting time. If
  that has changed, stop and report rather than rewriting a history missing commits.
- Do not merge anything in this ticket. Absorption is tickets 05 and 06, and it must not
  happen before relocation (ticket 02) — read-tree refuses to overwrite existing index
  entries, and 18 top-level paths collide between claude and codex.

## Done when

`docs/history/` holds both commit maps and an index, `pnpm verify` is green, and the PR
body records the `filter-repo` version and the path to both rewritten clones.
