# Task 01 — Foundation workspace

## Goal

Stand up the pnpm workspace skeleton and every verification gate so all later
tickets build on a green baseline.

## Criteria

1. Workspace packages exist: `proxy/`, `server/`, `packages/core/`, `apps/admin/`, each with its own `package.json` (`@ox-alpha-proxy/proxy`, `@ox-alpha-proxy/server`, `@ox-alpha-proxy/core`, `@ox-alpha-proxy/admin`) and a minimal entrypoint that typechecks.
2. Root scripts run: `pnpm verify` chains typecheck, test, build, check, anti:slop; every gate passes on an empty workspace.
3. Biome configured (format + lint + import sorting); anti-slop oxlint plugin installed with rules at `warn`.
4. `.github/workflows/verify.yml` runs the five gates as individual steps.
5. Toolchain pinned: Node >=22.18 engines, pnpm 11.5.2 via `packageManager`; lockfile committed.
6. `scripts/bootstrap-worktree.sh` symlinks env files plus `logs/` from the main checkout and installs with `--frozen-lockfile`; `.gitignore` lists `logs` without trailing slash.
7. `.env.example` files for proxy and server document upstream URL, bind addresses, audit directory, database path, `REPORT_TZ` (default `America/New_York`). No real `.env` is committed.
8. Proxy and core have zero runtime dependencies; core imports no Node modules.
9. Root `AGENTS.md` already exists — keep it accurate if tooling names change.

## Out of scope

Any domain code beyond stub entrypoints; any docs changes beyond fixing references broken by naming choices.

## Verification

Fresh clone: `pnpm install --frozen-lockfile && pnpm verify` exits zero.
