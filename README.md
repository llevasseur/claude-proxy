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

Its deliberate edits are the things the CLI can't be configured to keep out on
its own, both defined in `proxy/proxy.mjs`: **withheld tools** (`WITHHELD_TOOLS`,
e.g. `EndConversation`) that the CLI exempts from `permissions.deny`, and
**injected reminders** (`INJECTED_REMINDERS`, e.g. the task-tools nudge) that have
no suppression setting at all. Both are stripped from the request before
forwarding; requests with nothing to strip are forwarded byte-for-byte. The
dashboard's **Proxy filters** page (`GET /api/filters`) lists the full inventory
with the reason each one needs the proxy.

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

### Session transcripts — an append-only history per agent

Alongside the per-request logs, the proxy keeps a **Session transcript** for each
agent under `./logs/sessions/<threadId>.md`. Because every request carries the
full running `messages[]`, the proxy can reconstruct — passively, with no
agent-side hook — a durable, append-only record of what an agent did: a handoff
artifact if it dies mid-run, and a history that outlives its own context
compaction.

It is deterministic and lean by design. Each turn distills to a line: the
**task** (a user prompt), a **decision** (assistant text before a tool call), a
**tool** used (name + one key arg — never the schema or full input), a
**failure** (an errored tool result), or an **outcome** (a plain-text answer). It
never records the system prompt, tool schemas, tool-result payloads, or full
assistant prose.

Identity is per *conversation-root thread*, not per session id: one
`x-claude-code-session-id` carries the main agent, its subagents, and many tiny
one-shot helper calls, so each real thread is fingerprinted by its first user
message. One-shot helper calls (title-gen, summaries) are filtered out — a thread
that never grows past its first request never gets a file. A `<threadId>.state.json`
sidecar records progress so a proxy restart resumes instead of re-appending.

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

### Pointing `/revive` at the transcript store

`/revive --source proxy` resolves transcripts from **`CLAUDE_PROXY_STORE`** — the
directory holding `<threadId>.md` — and refuses to guess: unset or missing, and it
fails fast rather than hunting for a store. That directory is `<LOG_DIR>/sessions`,
so it depends on where this repo is checked out. `CLAUDE_PROXY_ARCHIVE` is optional
and only matters once whole days have been relocated out of the live `logs/` dir.

Run from a worktree, the resolution walks back to the main checkout
(`git rev-parse --git-common-dir`). That is deliberate: `LOG_DIR` follows the
*running* `proxy.mjs`, so every worktree's sessions land in the main checkout's
`logs/sessions`, and a worktree-local path would be an empty directory that
disappears with the worktree. An explicit `LOG_DIR` still wins.

Resolve both from the checkout itself, on request:

```bash
pnpm setup:env     # create the store dir, print the two device snippets
pnpm check:env     # report the resolved paths; non-zero when unconfigured
```

Nothing *changes* automatically — no install or dev-server hook — and `pnpm
setup:env` writes only inside the repo. (`pnpm zellij` runs the read-only
`--check` first and warns when the store is unresolved, but never fixes it for
you.) `setup:env` prints the two device snippets to add yourself:

```bash
# ~/.zshrc — every new shell, and every `claude` launched from one.
# Re-resolves on each shell, so moving this checkout needs no edit here.
source ~/Documents/ghub/claude-proxy/scripts/proxy-store-env.sh
```

Sessions that don't inherit a login shell (the Claude Code desktop app) read env
from `~/.claude/settings.json` instead, so add the resolved path to the same `env`
block as `ANTHROPIC_BASE_URL` above to cover those:

```jsonc
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8036",
    "CLAUDE_PROXY_STORE": "/Users/you/Documents/ghub/claude-proxy/logs/sessions"
  }
}
```

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
plus a spare shell tab. It runs `pnpm check:env` first — the panes inherit that
shell's environment, so an unresolved `CLAUDE_PROXY_STORE` is worth seeing while
a plain terminal is still on screen. A failing check warns and waits for Enter
rather than aborting; the proxy and dashboard panes work without the store.

Point the server at a different log directory with `LOG_DIR=/path/to/logs`, and
the dashboard at a different API with `VITE_API_BASE` (see `apps/admin/.env.example`).

### Starting a chat from the dashboard

The **Sessions** page has a prompt input: type into it and the turn goes out
through the proxy, so it lands in the logs, the transcripts, and the usage
digests like any other traffic.

Locally this needs no credential. By default the server spawns a **headless
Claude Code** (`claude --print`, pointed at the proxy) and that process
authenticates itself from your own Claude Code login — the server never holds a
key, and the turn bills the subscription you already have. The requirement is
just that `claude` is on `PATH` and logged in.

For a deployment, where there is no interactive login to inherit, switch to the
keyed HTTP client:

```bash
CHAT_TRANSPORT=api ANTHROPIC_API_KEY=sk-ant-... pnpm server
```

`GET /api/chat/config` reports which transport is live and, when a chat can't
start, exactly what's missing. Both paths are tunable per env — `CHAT_MODEL`,
`CHAT_SYSTEM`, `CHAT_BASE_URL`, `CHAT_TIMEOUT_MS`, plus `CHAT_CLI_PATH` and
`CHAT_CLI_CWD` for the child process. A `cli` turn is bounded by silence rather
than by total time — `CHAT_IDLE_TIMEOUT_MS` (default 5m, re-armed by the child's
own output) with `CHAT_MAX_TURN_MS` (default 1h) as the ceiling — so a long agent
loop is not killed mid-work. Details in
[docs/features/dashboard-chat-sessions.md](docs/features/dashboard-chat-sessions.md).

#### Agent mode — what a dashboard prompt can do

> **A prompt typed into the dashboard runs as a full Claude Code session by
> default, and it can read and write this repository and run commands in it.**

That is the point of the default mode: the child runs at parity with your own
`claude`, so your CLAUDE.md, settings, plugins, MCP servers, hooks, subagents and
custom slash commands (`/task` and the rest) all work, and the flags come from
your actual `claude` shell alias — withhold a tool there and the dashboard
withholds it too. Its reach is bounded to one directory, the checkout the server
is running from, and a headless child can't be asked to approve anything, so it
carries a standing `--permission-mode`.

**Which standing answer is a per-session choice**, picked next to the mode on the
start form and pinned for that session's life. It matters more than it sounds:
under the `acceptEdits` default, file edits are pre-approved but Bash is not, so
any command that would have prompted is auto-denied — an agent turn can rewrite a
file and cannot `git commit` it. `bypassPermissions` is the one that lets a
dashboard `/task` finish its git writes; `plan` is read-only. Picking it on the
form is what makes that a per-task decision instead of a server restart —
`CHAT_AGENT_PERMISSION_MODE` now only sets the default the form opens on (an
unrecognized value is ignored with a warning).

**A turn can be stopped.** Agent turns run for minutes; the Stop control ends the
one in flight without ending the session, and the reply comes back as the partial
one — the text and tool chips that arrived — rather than an error. The child leads
its own process group, so the shells and subagents it started go with it instead
of being orphaned in the repo. Failed tool chips carry the reason from the tool's
own result, so a permission denial reads as a denial.

There is no auth in front of that. The server binds locally and every other route
is read-only, but before exposing this port anywhere, switch to the sandboxed
posture — no tools, no device config, a scratch directory:

```bash
CHAT_MODE=chat pnpm server
```

The chat routes are the only writes the server accepts, and they do not answer
CORS `*` like the read-only ones: they echo only `CHAT_ALLOWED_ORIGINS`
(`http://localhost:5173` and its `127.0.0.1` form by default) and refuse a request
declaring any other origin with `403`. Serve the dashboard from somewhere else and
that origin has to be named there. It scopes the browser reach of the write
surface; it is not authentication, and anything that can reach the port directly
is unaffected.

Either mode can also be chosen per chat from the toggle on the Sessions page, and
it's fixed for the life of that session. `CHAT_AGENT_ALIAS` picks a different
alias to mirror. Design detail in
[docs/specs/2026-07-25-dashboard-agent-mode-design.md](docs/specs/2026-07-25-dashboard-agent-mode-design.md).

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
| `GET /api/filters` | the proxy's own strip inventory — withheld tools + injected reminders it removes from every request |

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
