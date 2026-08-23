# monorepo-fusion-10 — Unify the toolchain and land the CI gate

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-10-unify-toolchain-and-ci`
**Status:** done · 2026-08-23

## Goal

One root `verify`, one workflow, one set of shared config — taking each piece from
whichever repository has the better version, as the brief specifies.

## Criteria

**codex wins these.** claude-proxy currently has **no PR gate at all** — only
`deploy-concepts.yml`.

1. **The 5-gate root `verify` script**, verbatim in order:
   `pnpm typecheck && pnpm test && pnpm build && pnpm check && pnpm anti:slop`.
2. **`.github/workflows/verify.yml`**, one step per gate so a failure names the gate in
   the checks list. **Extend its `push` trigger** — codex's lists only `main`, and this
   campaign's integration branch is `the-great-merge`. Add both, plus
   `wayfinder/monorepo-fusion`, so campaign commits are gated too. Its `pull_request`
   trigger is unfiltered and already covers every campaign PR.
3. **`check` = `biome check . && pnpm check:docs`.** (The `check-docs.mjs` script itself
   is ticket 11 — do not wire `check:docs` in until that ticket lands, or `check` goes
   red on claude's 62 never-link-checked docs.)
4. **`.editorconfig`.** claude's biome sets `useEditorconfig: true` against a file that
   does not exist in this repository.
5. **`files.ignoreUnknown: true`.** The merged tree gains `.kdl`, `.sql`, `.grit` and
   `.plist`.

**claude wins these, and they survive verbatim.**

6. `.gitattributes` `CHANGELOG.md merge=union`, with its existing comment.
7. The `.agents/skills` → `.claude/skills` relative-symlink scheme wired into
   `postinstall` (`scripts/link-project-skills.sh`).
8. `style/noNonNullAssertion: off` — it fired at 255 sites, essentially all consequences
   of repo-wide `noUncheckedIndexedAccess`.
9. oxlint pinned exactly `1.78.0`; biome `^2.5.6`; single quotes; `lineWidth` 120.

**Both.**

10. **~~Drop `scripts/run-if-present.mjs`~~ — corrected: the root copy is already absent,
    and `stacks/codex/scripts/run-if-present.mjs` must STAY.** Three codex manifests
    reference it through `../scripts/` (`apps/admin` build and typecheck, `server` typecheck
    and test, `proxy` typecheck and test), and `pnpm-workspace.yaml` records that codex was
    deliberately left unflattened so those paths keep resolving. Deleting it breaks three
    codex packages.
11. **Keep exactly one copy of `tools/oxlint/anti-slop`** — claude's and codex's are
    byte-identical, verified at charting time.
12. **Add an empty `packages/shared/`** as the landing site for later convergence, with
    a `README.md` saying what it is for and that this campaign promotes nothing into it.
    - **Residual risk 4:** ox's root script is `pnpm -r typecheck` with **no
      `--if-present`**, while claude's and codex's both use it. A workspace package with
      no scripts breaks the bare form. Adopt `--if-present` in the merged root scripts,
      or give `packages/shared/` a no-op script — and verify a clean `pnpm install`
      followed by `pnpm verify` from a fresh clone.

## Done when

`pnpm install` from a fresh clone succeeds, `pnpm verify` runs all five gates green,
`verify.yml` fires on a PR into `the-great-merge`, and the root `run-if-present.mjs` and the
duplicate anti-slop copy are gone.
