---
label: wayfinder:map
slug: map-proxy-skim
---

# Map: Skim a thin layer off the top of requests to Anthropic

## Destination

An **opt-in "skim"** in claude-proxy that serves a safe subset of Anthropic
`/v1/messages` requests from a local response cache — on a hit it returns a
stored reply and makes **zero call to Anthropic** — and instruments every
request so hit-rate and dollars saved are measurable. The skim defaults **off**
and never changes the bytes Claude Code sees on a miss (the proxy stays a
transparent pass-through). Reaching the destination means: a rough prototype
that short-circuits real traffic, plus the audit data needed to study whether
the skim is worth keeping. A dashboard page to *study* that data is a named
future phase, not the destination itself.

## Notes

- **Domain:** the claude-proxy monorepo. `proxy/proxy.mjs` is a **zero-dependency**
  Node pass-through — any prototype must stay Node-built-ins only. `packages/core`
  is the pure/tested analysis lib, `server/` a read-only API over the audit
  sidecars, `apps/admin` the dashboard.
- **Execution is in scope for this map** (overrides wayfinder's plan-only
  default): the central Prototype ticket produces real code, not just a decision.
  The grilling/research tickets remain decisions.
- **Two cache layers, don't conflate them** (established with the user before
  charting): Anthropic's *prefix cache* is server-side transformer KV-state, ~90%
  off input tokens, 5-min/1-hr TTL, exact-prefix + per-org — **cannot** be moved
  to the proxy without self-hosting the model. The skim is an *app-layer response
  cache*: caches model **output**; a hit saves the **entire** API call and works
  cross-session / cross-user. This map builds the second, not the first.
- Skills to consult: `/grilling`, `/domain-modeling`, `/prototype`.
- Background/AFK caveat: HITL grilling tickets were charted from an extended prior
  conversation with the user, not a live session. Revisit their framing with the
  human before treating their answers as settled.

## Decisions so far

- [Exact-match skim short-circuit](tickets/001-exact-match-skim.md) — proxy now
  serves byte-identical repeat `/v1/messages` requests from a disk cache (opt-in
  `SKIM_CACHE=1`), replaying stored SSE with zero upstream call; audit sidecar
  gains `skim.servedFromCache` + `savedInputTokens` so hits are countable.
- [Cacheability of real traffic](research-002-cacheability-corpus.md) — byte-exact
  hit-rate floor is **0.7%** on 446 gated requests; recurrence is semantic (≤35
  system+tools scaffolds cover 92%), and volatile signals (date, cwd, git state,
  `tool_result`) are ~universal. Sharpens the semantic-skim layer and hands ticket
  003 the exclude/scope-on list for its key.

## Not yet specified

- **Semantic skim layer.** Embed the request and vector-match "same or similar
  task" above a threshold, instead of byte-exact hashing. High payoff (real
  agent traffic is rarely byte-identical) but carries wrong-answer risk and needs
  a threshold + scope keys. The floor data is now in (research 002: byte-exact 0.7%,
  but ≤35 system+tools scaffolds cover 92% — the payoff is real and only reachable
  semantically), so this is ready to graduate into a sharp ticket.
- **Cost-model / routing skim.** Routing cheap asks to a smaller model instead of
  caching. Adjacent lever, same seat in the proxy; revisit after the cache data
  lands.

## Out of scope

- **Self-hosting a frontier model** to own the prefix cache — the user explicitly
  wants to keep using frontier models; owning transformer KV-state is off the table.
- **Moving / replicating Anthropic's prefix cache** in the proxy — impossible
  without the model doing the forward pass. The skim caches output, not compute.
- **Injecting `cache_control` breakpoints into request bodies** to tune Anthropic's
  prefix cache — that's prompt-cache tuning of a request we still send; this effort
  is about *not sending* the request at all. Separate effort if wanted.
