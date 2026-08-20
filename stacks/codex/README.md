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

## Bike processes

Bike keeps three failure domains separate:

1. `proxy` forwards HTTP traffic and atomically writes sanitized audit sidecars.
2. `server` validates sidecars, materializes an idempotent SQLite view, and serves REST/SSE.
3. `admin` renders one Overview page from the server without handling upstream credentials.

SQLite is disposable. Final sanitized sidecars are the source of truth, so recovery is deletion of the database
followed by a complete re-ingest.

See the [Bike feature](docs/features/bike.md), [architecture](docs/specs/bike-architecture.md), and
[Bike-to-Plane roadmap](docs/roadmap/bike-to-plane.md).
