# claude-proxy — see (and monitor) the bloat in Claude Code's requests

A **pnpm monorepo** built around a zero-dependency logging proxy for Claude Code
and an admin dashboard that monitors usage, trends, and advice from what the
proxy captures.

```
proxy/          zero-dep capture proxy (the original proxy.mjs)
packages/core/  pure, tested library: usage digest, cost, advice
server/         read-only Node API over the logs + daily-summary CLI
apps/admin/     TanStack (Router + Query) + Vite dashboard
docs/           okq (Open Knowledge Format) bundle — ADRs, features, design specs
```

## 1. The proxy — capture requests

A transparent pass-through between Claude Code and the Anthropic API. It forwards
every request untouched (auth header and all), streams the reply straight back
(so the CLI is unaffected), and for each request writes a readable Markdown
document — led by a **ranked table of what is eating your context** — plus a
machine-readable `.audit.json` sidecar. Auth headers (`authorization`,
`x-api-key`, `api-key`) are written as `[REDACTED]`, so nothing sensitive lands
on disk.

```bash
node proxy/proxy.mjs          # zero deps, Node 18+
# point Claude Code at it in another terminal:
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

Each request lands in `./logs/<timestamp>_anthropic.{md,request.txt,audit.json}`.
The proxy still runs with bare `node` — no install required.

## 2. The dashboard — monitor usage

The `server` package reads those `.audit.json` sidecars and serves a read-only
JSON API; `apps/admin` renders it as a dashboard (token burn & estimated cost,
day-over-day trends, ranked tool bloat, and deterministic coaching advice). All
analysis lives in `packages/core` and is unit-tested.

```bash
pnpm install                  # wire the workspace (pnpm 11, Node 18+)

pnpm server                   # API on http://localhost:8788 (reads ./logs)
pnpm admin                    # dashboard on http://localhost:5173
```

Prefer one window? `pnpm zellij` opens the proxy, server, and dashboard in a
split-pane [zellij](https://zellij.dev) layout (`.zellij/claude-proxy.kdl`),
plus a spare shell tab.

Point the server at a different log directory with `LOG_DIR=/path/to/logs`, and
the dashboard at a different API with `VITE_API_BASE` (see `apps/admin/.env.example`).

Prefer the terminal? The same digest + advice as a one-shot text report:

```bash
pnpm summary                  # today
pnpm --filter server summary 2026-07-14   # a specific day
```

### API

| Route | Returns |
|---|---|
| `GET /api/health` | liveness, resolved `LOG_DIR`, sidecar count |
| `GET /api/summary?date=YYYY-MM-DD` | one day's digest + advice (+ trend vs prior day) |
| `GET /api/trends?days=N` | per-day digests for the last N days |
| `GET /api/tools?date=YYYY-MM-DD` | the ranked tool-bloat table for a day |

## Ports

| | Port |
|---|---|
| proxy | 8787 |
| server API | 8788 |
| admin (Vite dev) | 5173 |

## Develop

```bash
pnpm -r typecheck      # tsc across core, server, admin
pnpm -r test           # vitest (packages/core)
pnpm --filter admin build
```

## Docs (okq)

`docs/` is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog)
bundle queryable with [`okq`](https://github.com/mikevalstar/okq):

```bash
okq --bundle docs stats
okq --bundle docs find --type adr
okq --bundle docs search "advice"
```

It holds the architecture decisions, feature specs, and the two design docs:
device-wide daily summary (`docs/2026-07-13-…`) and this monorepo + dashboard
(`docs/superpowers/specs/2026-07-15-…`).

## Notes

- **Enterprise-safe:** the proxy is a transparent pass-through to
  `api.anthropic.com`; it copies no credential and redacts auth headers. See
  `docs/2026-07-13-claude-usage-summary-design.md`.
- Costs shown are **estimates** from an editable per-model price map in
  `packages/core/src/pricing.ts`.
- Anthropic `/v1/messages` only. (The proxy's console prefix reads `agent-proxy`
  for historical reasons — same tool.)
