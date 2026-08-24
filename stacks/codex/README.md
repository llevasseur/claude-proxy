# codex-proxy

`codex-proxy` is a local, transparent OpenAI/Codex proxy with a live overview of today's input tokens, output
tokens, and estimated cost. Bike stores sanitized metrics only: no request bodies, response bodies, prompts, tool
data, credentials, cookies, or arbitrary headers.

## Requirements

- Node.js 22.18 or newer
- pnpm 11.5.2

## Fresh clone

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Copy `.env.example` to `.env` when running the processes locally. Runtime logs, sidecars, status files, databases,
and environment files are ignored by Git.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm zellij` | opens `proxy`, `server` and `admin` together in one zellij session |
| `pnpm proxy` / `pnpm server` / `pnpm admin` | one process at a time |
| `pnpm verify` | every gate below, in order |
| `pnpm typecheck` / `pnpm test` / `pnpm build` | the per-package gates |
| `pnpm check` | Biome (lint, format, import order) plus the docs link check |
| `pnpm lint` / `pnpm format` | Biome's linter alone / Biome's fixer |
| `pnpm anti:slop` | the anti-slop oxlint rules |

CI runs the same five gates on every pull request. Working in a git worktree? Run
`bash scripts/bootstrap-worktree.sh` inside it first — see [AGENTS.md](AGENTS.md).

## Bike processes

Bike keeps three failure domains separate:

1. `proxy` forwards HTTP traffic and atomically writes sanitized audit sidecars.
2. `server` validates sidecars, materializes an idempotent SQLite view, and serves REST/SSE.
3. `admin` renders one Overview page from the server without handling upstream credentials.

SQLite is disposable. Final sanitized sidecars are the source of truth, so recovery is deletion of the database
followed by a complete re-ingest.

See the [Bike feature](../../docs/features/codex-bike.md),
[architecture](../../docs/specs/codex-bike-architecture.md), and
[Bike-to-Plane roadmap](../../docs/roadmap/bike-to-plane.md) in the repository-wide docs
bundle.
