# history

Commit maps from the `monorepo-fusion` campaign, which absorbed the `codex-proxy` and
`ox-alpha-proxy` repositories into this one as `stacks/codex` and `stacks/ox-alpha`.

Absorbing a repository means rewriting its history so every commit's tree sits under a
subdirectory (`git filter-repo --to-subdirectory-filter`). Rewriting a tree changes the
commit that contains it, so **every SHA in both source repositories changed**. Once those
repositories are archived, these two files are the only way to resolve a SHA that already
exists somewhere else — a permalink, an issue comment, a bookmark, a `git blame` someone
saved.

## The files

| File | Source repository | Rewritten into |
|------|-------------------|----------------|
| [codex-proxy-commit-map.txt](codex-proxy-commit-map.txt) | `llevasseur/codex-proxy` | `stacks/codex` |
| [ox-alpha-proxy-commit-map.txt](ox-alpha-proxy-commit-map.txt) | `llevasseur/ox-alpha-proxy` | `stacks/ox-alpha` |

Both were written by `git filter-repo` 2.47.0 to `.git/filter-repo/commit-map` in the
rewritten clone, and copied here unmodified.

## How to read one

Each file is a header line (`old`, `new`) followed by one line per commit: two 40-character
SHAs separated by a space.

    old                                      new
    023f843a4338060d807f5e3eb26fe6e49a98b640 469a2ba991bfc87cf89ce98497365b9a6aa2fe80

- The **left** column is the pre-rewrite SHA — what the commit was called in the source
  repository, and what an existing permalink points at.
- The **right** column is the post-rewrite SHA — what the same commit is called in this
  repository.
- A right column of **all zeros** means the commit was dropped by the rewrite and has no
  counterpart here. Neither of these two maps has such a line: the rewrite carried all 61
  `codex-proxy` commits and all 64 `ox-alpha-proxy` commits across.

To resolve an old SHA, grep for it in the left column:

    grep '^<old-sha>' docs/history/codex-proxy-commit-map.txt

Abbreviated SHAs will not match — the maps store full 40-character SHAs, so expand a short
SHA first or anchor the grep to a prefix.

## Why they are committed rather than regenerated

`git filter-repo` does not produce the same SHAs twice unless it is given the same input
history and the same options. Re-running the rewrite later would produce a different set of
new SHAs and these maps would then point at commits that are not in this repository. The
maps are a record of one specific rewrite, not a derivable artifact.

This folder carries no `okq:index` markers. `okq index` lists folders that hold OKF
concepts, and this one holds two `.txt` data files, so there is nothing for it to generate.
