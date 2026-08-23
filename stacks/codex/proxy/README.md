# codex-proxy proxy

The Bike proxy forwards arbitrary HTTP traffic to an OpenAI-compatible upstream and records sanitized usage only
for recognized `POST /v1/responses` and `POST /backend-api/codex/responses` exchanges. It runs directly from TypeScript source on Node 22.18 or newer and
has no runtime dependencies.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_UPSTREAM` | `https://chatgpt.com` | HTTP or HTTPS upstream origin. The ChatGPT OAuth flow only serves `/backend-api/codex/responses`; `https://api.openai.com` 404s it and suits an API key instead. |
| `PROXY_HOST` | `127.0.0.1` | Local listen address. |
| `PROXY_PORT` | `8026` | Local listen port, matching the port the `chadex` shell function calls. Use `0` to select a free port. |
| `AUDIT_DIR` | `logs/audit` | Directory for immutable `*.audit.json` sidecars. |
| `PROXY_STATUS_FILE` | `logs/proxy-status.json` | Body-free process status signal. |

Run it from the repository root:

```sh
pnpm --filter proxy start
```

Point Codex's OpenAI base URL at `http://<PROXY_HOST>:<PROXY_PORT>`. The proxy preserves methods, URLs, request
headers, request bodies, response status, response headers, and response stream bytes, except that it rewrites the
request `Host` header to the configured upstream host. Observation failures are reported as structured event names
and never alter an exchange already in flight.

## Filesystem contracts

Each completed recognized response with valid final usage creates one schema-v1 sidecar. A sidecar contains only a
record ID, completion timestamp, model, request pathname, response status, upstream request ID, normalized usage,
and complete or unavailable cost. Writes use a same-directory hidden `*.tmp` file, flush and close it, and atomically
rename it to an immutable `*.audit.json` name. Readers ignore every non-final filename.

`proxy-status.json` exposes `startup`, `ready`, `upstream-error`, and `shutdown` states. It contains only the update
time, process ID, local listen address, and upstream error count; it never stores the upstream URL, credentials,
headers, or bodies. A successful upstream connection returns the state to `ready`.
