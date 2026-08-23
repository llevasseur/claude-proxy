---
type: adr
title: Each stack keeps its own corpus at its own stack root
description: Relocation moves the data anchor silently; the resolvers stay unchanged and the three corpora are physically migrated with their own evidence.
tags: [monorepo, storage, corpus, migration]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 4
needs-human: true
---

# Each stack keeps its own corpus at its own stack root

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign. **A human has not ratified
this decision.** Flagged because it requires physically moving three untracked
multi-gigabyte data directories, which no gate in the campaign can verify and no commit
can revert.

## Context

All three stacks resolve their data root from their own file location, two levels up:
`claude-proxy/proxy/proxy.ts:57` (`path.join(HERE, '..', 'logs')`),
`codex-proxy/proxy/src/config.ts:5` and `ox-alpha-proxy/proxy/src/config.ts:18` (both
`resolve(import.meta.dirname, '..', '..')`). The griller asked:

> "Where does each stack's corpus live after relocation — does it move to
> `stacks/<name>/logs/`, which makes a physical migration of three untracked,
> gitignored data directories a required campaign step that `git mv` cannot perform and
> `pnpm verify` cannot confirm, or do the three resolvers get repointed at the monorepo
> root, which is a code change to path resolution inside a zero-behaviour-change
> campaign and puts three stacks' audit files in one directory?"

This is the campaign's only failure mode that is invisible to every gate it builds.
`git mv` moves the code and leaves the data, because git cannot move what it does not
track and `logs/` is gitignored. Tests use temp directories. Typecheck cannot see a path
constant. So on the day relocation lands, each stack silently begins a **new empty
corpus** while the accumulated one sits at the old path — and under the campaign's
capture decision, the corpus is the product.

## Decision

**Neither option as posed. The corpus lives at `stacks/<name>/logs/`, and the resolvers
are not touched.**

**The code does not change** because `import.meta.dirname/../..` never meant "the
repository root". It means **"my stack's root"** — the parent of my package. That is
what it meant in a single-stack repo, where the two coincided, and it is what it still
means afterwards: `stacks/codex/` genuinely *is* codex's root. The resolver's intent
survives relocation exactly; only the coincidence dies. Changing no path-resolution code
is the honest zero-behaviour-change move.

**The constants are renamed** `REPOSITORY_ROOT` → `STACK_ROOT`, with comments saying a
relative `AUDIT_DIR` resolves from the stack root rather than `process.cwd()` or the
repository root. After relocation the old name is a lie, and the next reader will
"correct" it back to the monorepo root. A rename and a comment, no behaviour.

**The corpora must not merge into one root `logs/`.** That is foreclosed by the
campaign's own ratified decision that there is one database and one controller per
proxy, so that no two proxies share a writer and one store failing costs only its own
provider's pages. Three stacks' audit files in one directory is one shared writer
surface.

**The physical migration is a required campaign step with its own evidence.** Three
untracked directories move by `mv`, once, on this device. Because `pnpm verify`
structurally cannot confirm it, **the ticket's done-condition is measurement, not a
green gate**: file count and `du -sb` byte count per corpus before and after, asserted
equal, plus a per-stack ingest smoke test proving each server reads from its new path.

> A step no gate can see gets an explicit proof, or it did not happen.

## Consequences

- claude's `logs` is a **symlink** in worktrees — which is why `.gitignore` carries
  `logs` with no trailing slash and `scripts/bootstrap-worktree.sh` links it from the
  main checkout. The migration moves the real directory and repoints the bootstrap
  script's targets. **Moving a symlink and calling it a corpus migration is how this
  ticket silently fails.**
- Blocker (d) is restated as an **anchor** mismatch as well as a default-value one:
  codex's server resolves from `cwd` (`server/src/config.ts:40`) while its own proxy
  resolves from `import.meta.dirname`, and `cwd` differs between a root script and
  `pnpm --filter`. codex's server adopts its proxy's anchoring and its `logs/audit`
  default. That is a runtime change and it is authorised, because the behaviour it
  changes is already broken: a fresh clone ingests nothing today. The rejection rule
  protects working behaviour, not a bug that has never worked.
- **Four root-anchored paths in `biome.json` break on relocation** and are repaired in
  the same ticket: `files.includes: "!logs"`; `formatter.includes: "!logs/**"`;
  `plugins: ["./apps/admin/lint/no-bare-size.grit"]`; and
  `overrides.includes: ["packages/core/src/index.ts"]`, the `noBarrelFile` exemption,
  which after relocation points at none of the three core barrels.
- The `!logs` replacement must be **empirically verified to still skip traversal at
  depth**, not merely to exclude. `AGENTS.md` records that `!logs` skips traversal while
  `!logs/**` still walks it, and that distinction is the whole reason the pattern is
  load-bearing. The ticket runs `biome check` against a `stacks/*/logs/` holding a known
  non-UTF-8 file and confirms it neither reports nor stalls.

## Provenance

Decided in this repository during `monorepo-fusion`. Depends on the ratified
one-database-per-proxy decision, which is what rules out the single shared `logs/`.
