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

A near-transparent pass-through between Claude Code and the Anthropic API. It
forwards each request essentially untouched (auth header and all), streams the
reply straight back (so the CLI is unaffected), and for each request writes a
readable Markdown document — led by a **ranked table of what is eating your
context** — plus a machine-readable `.audit.json` sidecar. Auth headers
(`authorization`, `x-api-key`, `api-key`) are written as `[REDACTED]`, so nothing
sensitive lands on disk.

Its one deliberate edit: it strips a small set of **withheld tools**
(`WITHHELD_TOOLS` in `proxy/proxy.mjs`, e.g. `EndConversation`) from the request
before forwarding — for tools the CLI exempts from `permissions.deny` and so
won't otherwise keep out. Requests with nothing to strip are forwarded
byte-for-byte.

```bash
PORT=8036 node proxy/proxy.mjs   # zero deps, Node 18+ (PORT defaults to 8787)
# point Claude Code at it in another terminal:
ANTHROPIC_BASE_URL=http://localhost:8036 claude
```

The proxy binds `PORT` (default `8787`). Override it — `PORT=8036 pnpm proxy` —
when that port is taken, and point `ANTHROPIC_BASE_URL` at the same port. The
zellij dev layout already launches the proxy on `8036`.

Each request lands in `./logs/<timestamp>_anthropic.{md,request.txt,audit.json}`.
The proxy still runs with bare `node` — no install required.

### Device setup (route every `claude` invocation through the proxy)

This is how it's set up on this machine: the proxy runs on `PORT=8036`,
and Claude Code's own `env` config — not a shell alias — points every
`claude` invocation at it. There's no zshrc change; Claude Code reads
`ANTHROPIC_BASE_URL` from its settings file on every launch.

1. Clone and install:

   ```bash
   git clone <this-repo> ~/Documents/ghub/claude-proxy
   cd ~/Documents/ghub/claude-proxy
   pnpm install
   ```

2. Start the proxy (pick one):

   ```bash
   PORT=8036 node proxy/proxy.mjs          # bare, no deps, no install needed
   # or, keep it running in the background:
   PORT=8036 node proxy/proxy.mjs &disown
   # or, launch it alongside server + dashboard in one zellij session:
   pnpm zellij                             # zellij dev layout already uses 8036
   ```

3. Point Claude Code at it via `~/.claude/settings.json` (device-wide,
   applies to every `claude` session):

   ```jsonc
   // ~/.claude/settings.json
   {
     "env": {
       "ANTHROPIC_BASE_URL": "http://localhost:8036"
     }
   }
   ```

   Auth still comes from your normal Claude Code credentials — the proxy
   only sits in front of the request, redacting auth headers before it
   writes them to disk.

4. Confirm it's wired up:

   ```bash
   claude --version   # any claude session now logs to ./logs/
   ```

   If the proxy isn't running, requests just fail — remove or comment out
   the `env` block in `~/.claude/settings.json` to fall back to hitting
   `api.anthropic.com` directly.

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

### Withholding tools device-wide ("Not added")

Once the proxy shows a tool is pure bloat, cut it at the source: a **bare tool
name** in `permissions.deny` in `~/.claude/settings.json` removes that tool's
schema from Claude's context entirely, so it never reaches the model and costs no
tokens per turn (a scoped rule like `Bash(rm *)` only blocks calls — the schema
still ships). This is device-wide: it applies to every Claude Code session on the
machine. See the [permissions docs](https://code.claude.com/docs/en/permissions).

```jsonc
// ~/.claude/settings.json
{
  "permissions": {
    "deny": [
      "Artifact",
      "EnterPlanMode",
      "PushNotification",
      "mcp__claude_ai_Linear__authenticate"   // exact MCP tool, or "mcp__claude_ai_Linear__*" for a whole server
    ]
  }
}
```

The dashboard's **Not added** page (`GET /api/withheld`) reads that device file
and lists what's withheld, then cross-references recent proxy traffic: a rule is
**still present** (red) if its tool is in the most recent captured request — still
reaching the model now (a session predating the rule is open, or the name doesn't
match) — **was present** (orange) if it only shows in older requests (pre-config
history aging out), or **absent** (green) once it's gone. Because it reads the
local `~/.claude/settings.json`, the page is device-specific.

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
| `GET /api/withheld?days=N` | the device's withheld-tool policy (`~/.claude` deny rules) + a check that each is absent from recent traffic |

## Ports

| | Port | Env var |
|---|---|---|
| proxy | 8787 (dev layout uses 8036) | `PORT` |
| server API | 8788 | `PORT` |
| admin (Vite dev) | 5173 | — (`VITE_API_BASE` → server) |

Both the proxy and server read the bare `PORT` var, so set it **per process**
(`PORT=8036 pnpm proxy`), not as a shared shell export, or they will collide.

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

- **Enterprise-safe:** the proxy is a near-transparent pass-through to
  `api.anthropic.com` (its only edit is stripping `WITHHELD_TOOLS`); it copies no
  credential and redacts auth headers. See
  `docs/2026-07-13-claude-usage-summary-design.md`.
- Costs shown are **estimates** from an editable per-model price map in
  `packages/core/src/pricing.ts`.
- Anthropic `/v1/messages` only. (The proxy's console prefix reads `agent-proxy`
  for historical reasons — same tool.)
