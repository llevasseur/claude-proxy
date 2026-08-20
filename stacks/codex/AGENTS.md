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
- Keep `proxy` and `@codex-proxy/core` free of runtime dependencies.
- Keep core deterministic: do not import Node modules or read the environment, clock, filesystem, database, or network.
- Run TypeScript source directly in the proxy and export TypeScript source directly from core. Do not add `dist/` to either package.
- Treat final sanitized audit sidecars as the source of truth and SQLite as rebuildable state.
- Do not persist request bodies, response bodies, prompts, tool data, credentials, cookies, or arbitrary headers in Bike.

## Verification

Install once with `pnpm install --frozen-lockfile`, then run `pnpm verify`.
