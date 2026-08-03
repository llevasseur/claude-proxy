# claude-proxy — see (and monitor) the bloat in Claude Code's requests

A **pnpm monorepo** built around a zero-dependency logging proxy for Claude Code
and an admin dashboard that monitors usage, trends, and advice from what the
proxy captures.

```
proxy/          zero-dep capture proxy (proxy.ts, run directly by node)
packages/core/  pure, tested library: usage digest, cost, advice
server/         Node API over logs + scoped local writes + daily-summary CLI
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
its own, both defined in `proxy/proxy.ts`: **withheld tools** (`WITHHELD_TOOLS`,
e.g. `EndConversation`) that the CLI exempts from `permissions.deny`, and
**injected reminders** (`INJECTED_REMINDERS`, e.g. the task-tools nudge) that have
no suppression setting at all. Both are stripped from the request before
forwarding; requests with nothing to strip are forwarded byte-for-byte. The
dashboard's **Proxy filters** page (`GET /api/filters`) lists the full inventory
with the reason each one needs the proxy.

```bash
PORT=8036 node proxy/proxy.ts   # zero deps, Node 22.18+ (PORT defaults to 8787)
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
   PORT=8036 node proxy/proxy.ts           # bare, no deps, no install needed
   # or, keep it running in the background:
   PORT=8036 node proxy/proxy.ts &disown
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
*running* `proxy.ts`, so every worktree's sessions land in the main checkout's
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

The `server` package reads those `.audit.json` sidecars and serves a JSON API
whose analysis surface is read-only, with a small allowlist of local chat and
suggestion-status writes. `apps/admin` renders it as a dashboard (token burn &
estimated cost, day-over-day trends, ranked tool bloat, and deterministic
coaching advice). All analysis lives in `packages/core` and is unit-tested.

```bash
pnpm install                  # wire the workspace (pnpm 11, Node 22.18+)

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
the form opens on `bypassPermissions`, the one that lets a dashboard `/task`
finish its git writes. The narrower modes are for turns that should not act:
under `acceptEdits` file edits are pre-approved but Bash is not, so any command
that would have prompted is auto-denied — an agent turn can rewrite a file and
cannot `git commit` it; `plan` is read-only. Picking it on the
form is what makes that a per-task decision instead of a server restart —
`CHAT_AGENT_PERMISSION_MODE` now only sets the default the form opens on (an
unrecognized value is ignored with a warning).

**A turn can be stopped.** Agent turns run for minutes; the Stop control ends the
one in flight without ending the session, and the reply comes back as the partial
one — the text and tool chips that arrived — rather than an error. The child leads
its own process group, so the shells and subagents it started go with it instead
of being orphaned in the repo. Failed tool chips carry the reason from the tool's
own result, so a permission denial reads as a denial.

There is no auth in front of that. The server binds locally and, apart from
suggestion-status flags, every other route is read-only. Before exposing this
port anywhere, switch to the sandboxed posture — no tools, no device config, a
scratch directory:

```bash
CHAT_MODE=chat pnpm server
```

The chat routes and suggestion-status updates are the only writes the server
accepts, and they do not answer CORS `*` like the read-only ones: they echo only
`CHAT_ALLOWED_ORIGINS`
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

### Browsing background jobs ("Jobs")

Claude Code keeps a directory per **background job** under `~/.claude/jobs/<id>` —
a `state.json` it rewrites as the job runs, a `timeline.jsonl` of its state
changes, and a `tmp/` holding whatever the run built. Like **Not added**, this is
device-wide and read off the local filesystem rather than captured traffic.

The **Jobs** page (`GET /api/jobs`) lists every one of those directories whichever
project it ran in, newest activity first, with its state, working directory, file
count and size. A directory whose job is gone is listed as a **husk** rather than
hidden — the scratch space is still on your disk.

Opening one (`GET /api/jobs/job?id=`) shows what the state file says — the prompt
it was given, the model and agent it ran as, any PR it opened, what it had in
flight at the last write — and presents the directory as a **folder tree**.
Selecting a file reads it (`GET /api/jobs/file?id=&file=`) with a **Pretty / Raw**
toggle: pretty re-indents JSON, renders `timeline.jsonl` as badged state changes,
strips terminal escapes and progress redraws out of a build log, numbers and
colours source, and inlines a screenshot; raw is the bytes on disk, for when you
suspect the pretty view of hiding something.

Each row also carries a **Delete** (`POST /api/jobs/delete`) that removes that job's
directory and everything under it — husks pile up and nothing else clears them.
It is a real `rm -r` with no trash behind it, so the first click arms the row and
the second does it, and the reply carries the refreshed listing plus what was
freed. A **running** job can't be deleted: its daemon is still writing there, so
the button is disabled and the API answers 409. Stop it first.

Reading is confined to the job directory — the id and every path segment are
validated, and the resolved path is `realpath`'d and re-checked, so a symlink left
in a job's `tmp/` can't read the rest of the filesystem. The delete re-runs that
check and refuses a symlinked job directory outright, and unlike the read routes it
answers only POST under the origin-checked write CORS. Point it elsewhere with
`CLAUDE_JOBS=/path/to/jobs`.

Prefer the terminal? The same digest + advice as a one-shot text report:

```bash
pnpm summary                  # today
pnpm --filter server summary 2026-07-14   # a specific day
```

### The query substrate (SQLite)

`logs/` is doc-shaped, so every read is a full directory scan. The server also
indexes the audit sidecars into **`logs/claude-proxy.db`** — SQLite via
`node:sqlite`, which is built into Node and therefore adds no dependency (it is
what first raised the engines floor to `>=22`; the proxy's unflagged type
stripping then took it to `>=22.18`). Ingest runs on server start and again on any
change to the log directory; it is idempotent and watermarked, so running it
twice or having it die halfway are both harmless.

The database is a **disposable materialized view**. `logs/` stays the sole
source of truth, the `.md` and `.request.txt` bodies are never copied into it
(only pointers, plus a `blob_evicted` flag for bodies retention has removed),
and nothing authored lives there — `logs/suggestion-status.json` and device
settings stay JSON files. So every table is reconstructible, and the supported
total-recovery path is simply to throw it away:

```bash
rm logs/claude-proxy.db && pnpm --filter server ingest   # rebuild from logs/
pnpm --filter server ingest                              # or just top it up
```

Reads are served from the database, and the way back is one flag: **`DB_READS=0`
puts every route back on the directory scan** it used before. That is the whole
rollback — the log files were never touched, so the scan still answers
everything. The server also falls back on its own if the database cannot be
opened. Set `SHADOW_DB=1` to have it compute each answer both ways and log any
disagreement; it checks whichever side did *not* serve, and never touches the
response. See
[ADR 0004](docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md) and the
[migration map](docs/wayfinder/map-sqlite-substrate.md).

### API

| Route | Returns |
|---|---|
| `GET /api/health` | liveness, resolved `LOG_DIR`, sidecar count |
| `GET /api/summary?date=YYYY-MM-DD` | one day's digest + advice (+ trend vs prior day) |
| `GET /api/trends?days=N` | per-day digests for the last N days |
| `GET /api/tools?date=YYYY-MM-DD` | the ranked tool-bloat table for a day |
| `GET /api/withheld?days=N` | the device's withheld-tool policy (`~/.claude` deny rules) + a check that each is absent from recent traffic |
| `GET /api/filters` | the proxy's own strip inventory — withheld tools + injected reminders it removes from every request |
| `GET /api/jobs` | every background job directory under `~/.claude/jobs`, newest activity first |
| `GET /api/jobs/job?id=` | one job's state plus its directory as a folder tree |
| `GET /api/jobs/file?id=&file=` | one file inside a job directory, for the pretty/raw viewer |
| `POST /api/jobs/delete` | delete one job directory from `~/.claude/jobs` (`{ id }`); refuses a running job |

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

### Worktree Setup

`git worktree add` brings only tracked files, so a fresh worktree has no
`node_modules/`, no `.env`, and — the one that bites — no `logs/`, leaving the
dashboard empty and `/health` failing. One script fixes all three:

```bash
bash scripts/bootstrap-worktree.sh
```

It finds the main checkout via `git rev-parse --git-common-dir` (no hardcoded
paths, same resolution `scripts/proxy-store-env.sh` uses), symlinks
`apps/admin/.env`, `proxy/.env`, and `logs/` from it, then runs `pnpm install
--frozen-lockfile`. Symlinks rather than copies, so the main checkout stays the
single source of truth and new sidecars show up in every worktree at once;
existing files are kept, missing ones skipped. It refuses to run from the main
checkout, and needs no branch or base — `/task` invokes it on any worktree it
creates.

## Docs (okq)

`docs/` is an [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog)
bundle queryable with [`okq`](https://github.com/mikevalstar/okq):

```bash
okq --bundle docs stats
okq --bundle docs find --type adr
okq --bundle docs search "advice"
```

It holds architecture decisions, feature specs, design specs, and the historical
Wayfinder campaign artifacts. Generated indexes under each folder list the
current concepts.

## Changelog

`CHANGELOG.md` at the repo root tracks every shipped change, in
[Keep a Changelog](https://keepachangelog.com/) form. There are no releases yet,
so everything sits under `[Unreleased]`, grouped by merge date (`MM-DD-YYYY`,
newest first) with `### Added` / `### Changed` / `### Fixed` sections and the
originating PR number on each entry. Add an entry with the work, not after it —
`/changelog` writes one from the branch diff in that shape.

## Notes

- **Enterprise-safe:** the proxy is a near-transparent pass-through to
  `api.anthropic.com`; its only request-body edits strip the small
  `WITHHELD_TOOLS` and `INJECTED_REMINDERS` inventories documented on the Proxy
  filters page. It copies no credential and redacts auth headers. See
  `docs/2026-07-13-claude-usage-summary-design.md`.
- Costs shown are **estimates** from an editable per-model price map in
  `packages/core/src/pricing.ts`.
- Anthropic `/v1/messages` only. (The proxy's console prefix reads `agent-proxy`
  for historical reasons — same tool.)
