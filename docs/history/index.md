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
  repository, and what an existing permalink points at. Look up by this one.
- The **right** column is the post-rewrite SHA, and it is the **authoritative** name: it
  is what the commit is called here, and the left-hand name is dead everywhere now that
  the source repositories are archived. Quote the right column in anything durable.
- A right column of **all zeros** means the commit was dropped by the rewrite. Neither
  map has such a line — the rewrite carried all 61 `codex-proxy` commits and all 64
  `ox-alpha-proxy` commits across.

**That last point is about the rewrite, not about this repository, and the difference
matters.** A map line says the rewrite computed a new SHA for a commit; it does not say
that commit is in this repository's history. See below.

To resolve an old SHA, grep for it in the left column:

    grep '^<old-sha>' docs/history/codex-proxy-commit-map.txt

Abbreviated SHAs will not match — the maps store full 40-character SHAs, so expand a short
SHA first or anchor the grep to a prefix.

## The maps are a superset of what was absorbed

**Every ref was mapped. Only `main` was absorbed.** `git filter-repo` rewrites a whole
object graph, so it minted a new SHA for every commit it could reach, including ones that
only ever sat on branches nobody merged. The absorption that followed merged a single
branch. So a map line can be perfectly correct and still name a commit this repository
does not contain, and looking one up gives no hint that anything is wrong — you get back
a well-formed 40-character SHA that resolves to nothing.

| Map | Entries | Resolve here |
|---|---|---|
| `ox-alpha-proxy-commit-map.txt` | 64 | all 64 — the map covers exactly `main` |
| `codex-proxy-commit-map.txt` | 61 | 44 — the other **17** came from abandoned branches |

Those 17 are the sharp edge. A permalink into one of them maps to a SHA that exists in
neither repository: not here, because the branch was never merged, and not in
`llevasseur/codex-proxy`, because the rewrite renamed every commit it had. The content is
not lost — it is in the archived source under its original name — but the map cannot
bridge to it, and the map will not say so.

**So the repository is the authority on existence, and the map only on naming.** Check
before trusting a lookup:

    git cat-file -e <new-sha>^{commit} && echo present

A non-zero exit means the commit was mapped but not absorbed, which is an expected answer
for a codex SHA rather than a sign the map is wrong.

## Why they are committed rather than regenerated

`git filter-repo` does not produce the same SHAs twice unless it is given the same input
history and the same options. Re-running the rewrite later would produce a different set of
new SHAs and these maps would then point at commits that are not in this repository. The
maps are a record of one specific rewrite, not a derivable artifact.

This folder carries no `okq:index` markers. `okq index` lists folders that hold OKF
concepts, and this one holds two `.txt` data files, so there is nothing for it to generate.
