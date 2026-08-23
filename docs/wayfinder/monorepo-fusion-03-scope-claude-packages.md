# monorepo-fusion-03 — Scope claude's packages and add the rename gate

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-03-scope-claude-packages`
**Status:** done · 2026-08-23

## Goal

Give every package in this repository an `@agent-proxy/*` name, regenerate the lockfile
in the same commit, and add the `verify` gate that makes an unscoped `--filter` argument
impossible to leave behind.

## Criteria

1. **Rename the packages.** Current names are unscoped and collide with codex's on
   absorption, which is why this lands before anything installs:
   - `proxy` → `@agent-proxy/claude-proxy`
   - `server` → `@agent-proxy/claude-server`
   - `@claude-proxy/core` → `@agent-proxy/claude-core`
   - `admin` → `@agent-proxy/claude-admin`
   - `concepts` → `@agent-proxy/concepts`

   **Bins keep their current names.** The root package keeps its own name.
2. **Update every `.ts`/`.tsx` import site.** 136 files reference `@claude-proxy/core`;
   81 `.ts`, 45 `.tsx`, and the remainder are handled by criteria 3 and by ticket 04.
   Typecheck catches all of these and none of the others.
3. **Regenerate `pnpm-lock.yaml` and commit it in the same commit as the
   `package.json` renames.** A lockfile one commit behind its manifests is a broken
   install for anyone who checks out the intermediate commit.
4. **Add the rename gate to `verify`.** After this ticket, **no `--filter` argument
   anywhere in the tree may name an unscoped package.** Implement it as a script that
   greps the tree and exits non-zero on a match, and wire it into the root `verify`
   chain. This is the positive assertion the rename otherwise lacks: pnpm answers a
   filter matching nothing with a **warning and exit 0**, so every non-import consumer
   of a package name fails open. See ADR 0055.
   - The gate must scan `.md`, `.json`, `.yaml`/`.yml`, `.sh` and `.plist` as well as
     TypeScript, because 29 of the 184 rename sites are not TypeScript.
   - It must fail on `--filter server`, `--filter concepts`, `--filter admin`,
     `--filter proxy`, and any other bare unscoped name.
5. **Leave the 130 non-import references failing for now.** Ticket 04 fixes them. This
   ticket's gate is what makes ticket 04's completion checkable; expect the gate to be
   red between the two and say so in the PR body.

## Constraints

- **Zero behaviour change.** A rename is not a behaviour change; anything that alters
  what a package *does* belongs in another ticket.
- Do not rename the bins. `claude-proxy` stays `claude-proxy`.

## Done when

`pnpm install` at the root succeeds, `pnpm typecheck` is green, the lockfile is
regenerated in the rename commit, and the new gate exists and correctly reports the
outstanding non-import references that ticket 04 will clear.
