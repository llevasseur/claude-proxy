# agent-proxy — see the bloat in Claude Code's requests

A zero-dependency logging proxy that sits between Claude Code and the Anthropic
API. It forwards every request untouched, streams the reply straight back (so the
CLI is unaffected), and writes a readable Markdown document for each request —
led by a **ranked table of what is eating your context**.

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
Node 18+. Anthropic `/v1/messages` only.
