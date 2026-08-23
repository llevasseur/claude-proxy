# ox-alpha-proxy

A transparent OpenAI Responses proxy with sanitized usage observability, rebuilt
clean-room from the recorded decisions of `codex-proxy`.

Four independently useful outcomes, delivered in order:

1. **Bike** — transparent forwarding plus one live Overview of today's tokens and cost.
2. **Car** — durable history, trends, date ranges, and model/range filters.
3. **Boat** — explicit opt-in body capture with redaction and retention, then inspection.
4. **Plane** — parity with the pinned `claude-proxy` commit.

Read [the roadmap](docs/roadmap/four-rungs-to-plane.md) and
[the decision records](docs/adrs/index.md) before changing anything.

## Running locally

Copy `proxy/.env.example`, `server/.env.example`, and `apps/admin/.env.example`
to `.env` beside each one first. Ports live in those files, and the defaults
collide with any other proxy already running on the same machine.

```bash
pnpm install --frozen-lockfile
pnpm zellij
```

`pnpm zellij` runs the proxy, server, and dashboard as three panes of one
session ([`.zellij/ox-alpha-proxy.kdl`](.zellij/ox-alpha-proxy.kdl)) and stops
all three when the terminal closes. Run them separately instead with:

```bash
pnpm proxy    # transparent proxy
pnpm server   # HTTP/SSE API and SQLite view
pnpm admin    # dashboard dev server
```

Point `AUDIT_DIR` at the same directory for both the proxy and the server. Each
resolves it against its own working directory, which differs per package under
`pnpm --filter`, so a relative path silently gives them separate sidecar
directories and the server reports no traffic. An absolute path avoids it.
