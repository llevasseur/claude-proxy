# monorepo-fusion-05 — Absorb codex-proxy

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-05-absorb-codex`
**Status:** done · 2026-08-23

## Goal

Merge codex-proxy's rewritten history into this repository under `stacks/codex/`, scope
its packages, and repair the two configuration defects that make a fresh codex clone
ingest nothing.

## Criteria

1. **Absorb the rewritten history** produced by ticket 01:
   `git merge --allow-unrelated-histories --no-ff`. Every codex SHA is preserved under
   its rewritten form; the commit map from ticket 01 is the bridge to the originals.
2. **Scope its packages**: `proxy` → `@agent-proxy/codex-proxy`, `server` →
   `@agent-proxy/codex-server`, `@codex-proxy/core` → `@agent-proxy/codex-core`,
   `admin` → `@agent-proxy/codex-admin`. Update its 19 import-site files. Bins keep
   their names.
3. **Fix blocker (d), which is an anchor mismatch as well as a default mismatch.**
   `codex-proxy/server/src/config.ts:40` resolves `AUDIT_DIR` from `cwd` and defaults to
   `logs`, while `codex-proxy/proxy/src/config.ts:40` resolves from
   `import.meta.dirname` and defaults to `logs/audit`. So the server reads a directory
   the proxy never writes, and `cwd` additionally differs between a root script and
   `pnpm --filter` — which is exactly what this campaign changes.
   - The server adopts its own proxy's anchoring **and** its `logs/audit` default.
   - **This is an authorised runtime change.** The behaviour it changes is already
     broken: a fresh clone ingests nothing today. The rejection rule protects working
     behaviour, not a bug that has never worked. Say so in the PR body.
   - Update `stacks/codex/server/README.md`, which documents the wrong default.
4. **Rename `REPOSITORY_ROOT` → `STACK_ROOT`** in both codex config files, with the
   comment saying a relative `AUDIT_DIR` resolves from the stack root rather than
   `process.cwd()` or the repository root (ADR 0054). After relocation the old name is a
   lie and the next reader will "correct" it back to the monorepo root.
5. **Apply the env-var scoping from ADR 0050.** codex's server reads `PORT`, which
   collides with claude's proxy once one root `.env` exists and
   `--env-file-if-exists=../.env` points at it. It becomes `CODEX_SERVER_PORT`, **with
   the bare `PORT` still honoured as a fallback scoped to that package alone**. Add the
   three config-test cases: scoped name wins, legacy name still resolves, default is the
   unchanged `4319`.
6. **Repoint `--env-file-if-exists=../.env`** to the new root (blocker (g)).
7. **Do not change codex's default ports.** Proxy stays `8026`, server stays `4319`.

## Constraints

- Relocation (ticket 02) must already have landed — 18 top-level paths collide between
  claude and codex, and read-tree refuses to overwrite existing index entries.
- codex's `biome.json` is claude's almost line for line, so no warn tier is needed for
  it. That asymmetry is ox's alone (tickets 07 and 08).

## Done when

`pnpm install` succeeds, `pnpm verify` is green, codex's own tests pass unchanged, and a
fresh-clone smoke test shows the codex server ingesting sidecars its proxy wrote.
