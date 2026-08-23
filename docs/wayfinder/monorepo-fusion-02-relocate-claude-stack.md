# monorepo-fusion-02 — Relocate claude-proxy's packages under stacks/claude

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-02-relocate-claude-stack`
**Status:** active

## Goal

Move this repository's four packages under `stacks/claude/`, keeping every SHA, and
repoint every root-anchored path the move breaks. Relocation must land before either
sibling is absorbed.

## Criteria

1. **One plain `git mv` commit**, nothing else in it:
   - `proxy/` → `stacks/claude/proxy/`
   - `server/` → `stacks/claude/server/`
   - `packages/core/` → `stacks/claude/core/`
   - `apps/admin/` → `stacks/claude/admin/`

   Root keeps `docs/`, `tools/`, `scripts/`, `.agents/`, `services/concepts/`,
   `.github/`, `CHANGELOG.md`, `.gitattributes`, and the root config files.
   `tmp/` (a lone `.gitkeep`) and `skills-lock.json` stay at root.
2. **Repair the four root-anchored paths in `biome.json`** (ADR 0054):
   - `files.includes: "!logs"` — must also exclude `stacks/*/logs/`. **The replacement
     must be empirically verified to still skip traversal at depth, not merely to
     exclude.** `AGENTS.md` records that `!logs` skips traversal while `!logs/**` still
     walks it, and that directory holds non-UTF-8 audit bytes. Prove it: run
     `biome check` against a `stacks/*/logs/` containing a known non-UTF-8 file and
     confirm it neither reports nor stalls.
   - `formatter.includes: "!logs/**"` — same directory, already in the weaker form.
   - `plugins: ["./apps/admin/lint/no-bare-size.grit"]` → `stacks/claude/admin/...`.
   - `overrides.includes: ["packages/core/src/index.ts"]` — the `noBarrelFile`
     exemption, which after relocation points at no core barrel.
3. **Repoint `tsconfig.base.json` and every `extends`** in the four relocated packages.
4. **Repoint every root `package.json` script filter** that names a relocated path.
5. **Update `pnpm-workspace.yaml`** to `stacks/*/*`, `packages/*`, `services/*`.
6. **Update `.github/workflows/deploy-concepts.yml`'s `paths` filter** — it watches
   `packages/core/**`, which no longer exists. Left stale it silently stops firing,
   which looks identical to always passing. (Its `--filter concepts` argument is
   ticket 04's; both halves are needed and this ticket owns only the trigger.)
7. **Do not touch any path-resolution code.** `LOG_DIR = path.join(HERE, '..', 'logs')`
   in `stacks/claude/proxy/proxy.ts` is correct after the move and stays as it is —
   see ADR 0054. Moving the corpus itself is ticket 09.

## Constraints

- **Zero behaviour change.** No default port, no env-var name, no path constant changes
  in this ticket.
- 367 of 510 tracked files relocate — under git's default 1000 rename limit, so rename
  detection survives, but keep the `git mv` commit free of content edits so it stays a
  pure rename for `git log --follow` and for later merges from `main`.

## Done when

`pnpm install` at the root succeeds, `pnpm verify` is green, `git log --follow` on a
relocated file still reaches its full history, and the biome traversal proof from
criterion 2 is in the PR body.
