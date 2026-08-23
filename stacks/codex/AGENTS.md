# Repository agent instructions

## Repository map

This pnpm workspace has four packages:

- `proxy/`: a zero-runtime-dependency transparent OpenAI proxy executed directly from TypeScript source.
- `server/`: the local HTTP/SSE API and disposable SQLite materialized view.
- `packages/core/`: pure usage, pricing, sidecar, and Today-domain code with no runtime dependencies.
- `apps/admin/`: the React/TanStack Overview dashboard.

Durable product records live in `docs/features/`, `docs/specs/`, `docs/roadmap/`, and `docs/adrs/`.
Files under `docs/plans/` are temporary Wayfinder scaffolding.

## Constraints

- Require Node 22.18 or newer and pnpm 11.5.2.
- Keep `proxy` and `@agent-proxy/codex-core` free of runtime dependencies.
- Keep core deterministic: do not import Node modules or read the environment, clock, filesystem, database, or network.
- Run TypeScript source directly in the proxy and export TypeScript source directly from core. Do not add `dist/` to either package.
- Treat final sanitized audit sidecars as the source of truth and SQLite as rebuildable state.
- Do not persist request bodies, response bodies, prompts, tool data, credentials, cookies, or arbitrary headers in Bike.

## Worktree Setup

`git worktree add` materializes tracked files only, so a fresh worktree has no
`node_modules/`, no `.env` and no `logs/`. Run `bash scripts/bootstrap-worktree.sh` from
inside it: the script symlinks every `.env` the main checkout actually has (`.env`,
`proxy/.env`, `server/.env`, `apps/admin/.env` — missing ones are skipped) plus `logs/`,
then runs `pnpm install --frozen-lockfile`. It resolves the main checkout from
`git rev-parse --git-common-dir`, so no path is hardcoded and no base branch is assumed.

Nothing is generated. `@agent-proxy/codex-core` exports TypeScript source and `proxy` runs from
source, so install is the whole build — `ERR_MODULE_NOT_FOUND` in a fresh worktree means
it was never bootstrapped, not that something needs compiling. A missing `logs/` is the
same symptom, not data loss.

`.gitignore` lists `logs` **without** a trailing slash, and that is load-bearing rather
than sloppy: in a worktree `logs` is a symlink, which `logs/` would not match.

## Verification

Install once with `pnpm install --frozen-lockfile`, then run `pnpm verify` — which chains
the same five gates CI runs as separate steps:

| Script | What it runs |
| --- | --- |
| `pnpm typecheck` | `tsc --noEmit` per package |
| `pnpm test` | vitest (core, server) and `node --test` (proxy) |
| `pnpm build` | the admin bundle; every other package has no build |
| `pnpm check` | `biome check .` (lint + format + import sorting, read-only) plus `pnpm check:docs` |
| `pnpm anti:slop` | the anti-slop oxlint plugin |

`pnpm format` (`biome check --write .`) is the fixer and `pnpm lint` (`biome lint .`)
narrows to the linter alone. `.github/workflows/verify.yml` runs the five gates as
individual steps so a failure names the gate rather than one opaque script.

**The anti-slop rules are set to `warn` here, not `error`.** The plugin, its config and
its script names are copied from `claude-proxy` unchanged, but this codebase predates the
rules and starts at 94 findings — most of them `no-unknown-parameters`,
`no-unsafe-dictionary-type` and `no-runtime-typeof` in the sidecar-validation boundary,
where satisfying them means designing a parser layer inside a package that is required to
stay dependency-free. `warn` keeps every file linted and the backlog visible on each run
while CI stays green. Ratchet a rule to `error` once its findings reach zero; that is the
path to full parity with `claude-proxy`, where these are all `error`.

## Running everything

`pnpm zellij` opens all three Bike processes in one zellij session using
`.zellij/codex-proxy.kdl` — `proxy`, `server` and `admin` in a `dev` tab, plus a spare
shell tab. No port is pinned in the layout. `proxy` and `server` run under
`pnpm --filter`, so their cwd is the package directory, and both pass
`--env-file-if-exists=../.env` to reach the repository-root `.env` from there —
`PROXY_PORT` and `OPENAI_UPSTREAM` no longer have to be exported into the shell that
launches `pnpm zellij`. `admin` is Vite, which loads `apps/admin/.env`. The script warns
and waits if it finds none of those files.

The proxy's built-in `PROXY_PORT` default is `8026` — the port the `chadex` shell
function calls — so even a start that reaches no `.env` at all binds where `chadex`
looks. It is deliberately not the `8787` the other proxies checked out beside this one
default to; sharing that number means whichever process starts second loses the bind.

Relative paths in that root `.env` — `AUDIT_DIR`, `DATABASE_PATH`, `PROXY_STATUS_FILE`,
`PROXY_STATUS_PATH` — resolve against the repository root rather than the launching cwd,
so a pane started under `pnpm --filter` and a root-level `node proxy/src/proxy.ts` write
to the same `logs/`. Absolute values still win. Plane's processes belong as further panes
in that same layout rather than in a second one.

Individually: `pnpm proxy`, `pnpm server`, `pnpm admin`.
