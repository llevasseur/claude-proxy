# claude-proxy — see the bloat in Claude Code's requests

A zero-dependency logging proxy that sits between Claude Code and the Anthropic
API. It forwards every request untouched (auth header and all), streams the reply
straight back (so the CLI is unaffected), and writes a readable Markdown document
for each request — led by a **ranked table of what is eating your context**.

Auth headers (`authorization`, `x-api-key`, `api-key`) are written as `[REDACTED]`
in the logs, so nothing sensitive lands on disk.

## Run it

```bash
node proxy.mjs
```

Then point Claude Code at it in another terminal:

```bash
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

Send one message. Each request is written to `./logs/<timestamp>_anthropic.md`,
and a ranked tool table prints to the terminal:

```
[agent-proxy] 69 tools · 154,946 tool bytes · 65,538 real input tokens
  Workflow      21229 B  ~5307 tok
  DesignSync     8978 B  ~2245 tok
  Monitor        7767 B  ~1942 tok
  …
```

Open the `.md` file to read the entire request — every tool schema, the system
prompt, the message history — exactly as it was sent to the model. Requires
Node 18+. Anthropic `/v1/messages` only. (The console prefix reads `agent-proxy`
for historical reasons — same tool.)

## Roadmap — daily usage summary

This repo is also the hub for a device-wide Claude Code usage monitor: capture
every request here, then have a local agent produce a once-daily end-of-day
summary (token burn & cost, context-bloat culprits, activity, and coaching on how
to use the agent more efficiently). The design is specced in
[`docs/2026-07-13-claude-usage-summary-design.md`](docs/2026-07-13-claude-usage-summary-design.md);
implementation lives partly here (a JSON audit sidecar) and partly in a separate
eve agent project.
