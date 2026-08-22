# ox-alpha-proxy agent instructions

ox-alpha-proxy is a clean-room rebuild of `codex-proxy` from its recorded
decisions. It is a pnpm workspace with four packages:

- `proxy/`: a zero-runtime-dependency transparent OpenAI Responses proxy executed directly from TypeScript source.
- `server/`: the local HTTP/SSE API and disposable SQLite materialized view.
- `packages/core/`: pure usage, pricing, sidecar, and Today-domain code with no runtime dependencies.
- `apps/admin/`: the React/TanStack dashboard.

## Constraints

- Require Node 22.18 or newer and pnpm 11.5.2.
- Keep `proxy` and `@ox-alpha-proxy/core` free of runtime dependencies.
- Keep core deterministic: do not import Node modules or read the environment, clock, filesystem, database, or network.
- Run TypeScript source directly in the proxy and export TypeScript source directly from core. Do not add `dist/` to either package.
- Treat final sanitized audit sidecars as the source of truth and SQLite as rebuildable state.
- Do not persist request bodies, response bodies, prompts, tool data, credentials, cookies, or arbitrary headers.

## Clean-room boundary

Documents govern outcomes; codex-proxy source is a mechanics reference where the
corpus is silent. When a plan under-specifies a concrete mechanic — pricing
rates, Responses SSE usage selection, recordId generation, DST boundaries —
port the codex-proxy mechanic faithfully and cite it in the plan. Where a
genuine choice exists that neither docs nor code settles, write an unratified
needs-human decision record instead of picking silently.

## Verification

Install once with `pnpm install --frozen-lockfile`, then run `pnpm verify`,
which chains five gates: typecheck (`tsc --noEmit` per package), test
(vitest for core and server, `node --test` for proxy), build (the admin bundle),
check (`biome check .` plus the docs link lint), and anti-slop (oxlint with
warn-level rules; the claude-proxy anti-slop plugin is not yet installed, so
equivalent categories stand in until it can be ported). Anti-slop rules start at
`warn`; ratchet a rule to `error` once its findings reach zero.

## Worktrees

Fresh worktrees have no `node_modules/`, `.env`, or `logs/`. Bootstrap them with
`bash scripts/bootstrap-worktree.sh`, which symlinks env files plus `logs/`
from the main checkout and runs `pnpm install --frozen-lockfile`. `.gitignore`
lists `logs` without a trailing slash because a worktree's `logs` is a symlink.
