---
id: "001"
title: Exact-match skim short-circuit in the proxy
map: map-proxy-skim
labels: [wayfinder:prototype]
assignee: claude
blockedBy: []
status: closed
---

## Question

Can the proxy short-circuit a repeat request — serve the reply from a local
cache and skip Anthropic entirely — without changing what Claude Code sees? Build
the cheapest safe version to react to: **byte-exact match**, opt-in, replaying the
stored SSE stream. Exact input means replaying the same output is the safe floor;
semantic matching is a later ticket. Instrument hits so the study phase can count
them.

## Resolution

Built. Opt-in via `SKIM_CACHE=1` (default off, proxy stays a transparent
pass-through). New zero-dep module `proxy/skim.mjs`; `proxy/proxy.mjs` wired to
check the cache before opening the upstream request.

- **Key:** `sha256(rawRequestBody)`, scoped implicitly by model (model is in the
  body). Gate: streamed `/v1/messages` only, skim enabled.
- **Hit:** replay stored raw SSE bytes with the stored status + content-type,
  `res.end()`, **no upstream call**. Logs `SKIM HIT` + an audit sidecar with
  `skim.servedFromCache = true` and `savedInputTokens`.
- **Miss:** unchanged pass-through; on a 200 the raw response bytes + input-token
  count are stored under `.skim-cache/<key>.{sse,meta.json}`.
- **TTL:** `SKIM_TTL_MS` (default 1h); stale entries are ignored on lookup.
- **Audit:** `writeAuditSidecar` gained an optional `skim` block so both hits and
  misses are analyzable by `server/` + `packages/core` later.

Env: `SKIM_CACHE`, `SKIM_TTL_MS`, `SKIM_DIR`. Cache dir defaults to
`<repo>/.skim-cache` (added to `.gitignore`).

Known rough edges (feed the next tickets): byte-exact keying hits rarely in real
agent traffic — raw hit-rate is the number ticket 002/003 need; replaying a stored
reply is unconditional within TTL — no dependency/staleness check yet (ticket 003);
no correctness guardrails beyond opt-in + TTL (ticket 004).
