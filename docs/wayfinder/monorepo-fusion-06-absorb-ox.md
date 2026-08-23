# monorepo-fusion-06 — Absorb ox-alpha-proxy

**Wayfinder:** `monorepo-fusion`
**Branch:** `task/monorepo-fusion-06-absorb-ox`
**Status:** active

## Goal

Merge ox-alpha-proxy's rewritten history under `stacks/ox-alpha/`, scope its packages,
and settle what "one toolchain" means for a stack with no shared tsconfig base.

## Criteria

1. **Absorb the rewritten history** from ticket 01:
   `git merge --allow-unrelated-histories --no-ff`.
2. **Scope its packages**: `@ox-alpha-proxy/{proxy,server,core,admin}` →
   `@agent-proxy/ox-{proxy,server,core,admin}`. Update its 29 reference files. Bins keep
   their names.
3. **Settle the tsconfig question — residual risk 1.** ox has **no
   `tsconfig.base.json`**, so blocker (g)'s "repoint every `extends`" does not reach it:
   it has four standalone configs (`proxy/`, `server/`, `packages/core/`, `apps/admin/`)
   with no `extends` at all.
   - The strictness delta is small and measured: all four already set `strict: true` and
     `noUncheckedIndexedAccess: true`. They lack `noImplicitOverride`, which both other
     bases set.
   - **Decide and record which way it goes**, because "one toolchain" is otherwise
     unified in name only. Unlike lint, **tsconfig has no severity levels**, so there is
     no warn tier available — adopting the shared base is all-or-nothing and any new
     error must be fixed in the same ticket.
   - Recommended: adopt the shared base, since `noImplicitOverride` is the only delta
     and a stack outside the shared base is not in the toolchain. If adoption produces
     more than a handful of errors, keep the four standalone configs, say so in the PR
     body, and add a ticket for it in campaign 2 rather than editing ox source here.
4. **Apply the env-var scoping from ADR 0050** to `OX_PROXY_PORT`/`OX_SERVER_PORT`, each
   with its current bare name as a package-scoped fallback, plus the three config-test
   cases. ox already uses `PROXY_PORT`/`SERVER_PORT`, so the collision is narrower than
   codex's — but ox's server default of `8788` **collides with claude's server**, and
   the scoped names are what make that overridable. **Do not change either number**: the
   duplication is pre-existing, not fusion-caused, and is documented in ticket 14.
5. **Rename ox's `REPOSITORY_ROOT` → `STACK_ROOT`** with the same comment as ticket 05.
6. **Drop ox's version pins in favour of the root's**: biome `~2.2.0` → `^2.5.6`, oxlint
   `~1.12.0` → exactly `1.78.0`, one TypeScript. The single lockfile forces this anyway.
7. **Do not change ox's default ports.** Proxy stays `8807`.
8. **Promote nothing from ox's admin into `packages/shared/`.** ox's dashboard is
   retired in campaign 3, not harvested here. This obligation is negative and absolute.

## Expected state on exit

`biome check` and `oxlint` will be **red on ox source** after this ticket — ox has never
run either at these versions. That is expected and is tickets 07 and 08's work. Say so
in the PR body rather than fixing it here, and do not reformat anything in this ticket.

## Done when

The history is absorbed, packages are scoped, `pnpm install` succeeds, `pnpm typecheck`
and `pnpm test` are green including ox's own tests unchanged, and the tsconfig decision
from criterion 3 is recorded in the PR body with its error count.
