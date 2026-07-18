---
id: "003"
title: Cache key & invalidation policy
map: map-proxy-skim
labels: [wayfinder:grilling]
assignee: null
blockedBy: ["002"]
status: open
---

## Question

Decide the cache key and staleness rules that move the skim past byte-exact
matching without serving wrong answers. Grill through, one question at a time:

- **Key composition** — what goes into the hash beyond the raw body? Model,
  project id, relevant file hashes, tool-schema version? The key must encode
  everything the answer depends on, so staleness is structural, not luck.
- **Exact vs semantic** — is byte-exact enough (safe, low hit-rate) for the use
  the user actually has, or is an embed + vector-match threshold worth the
  wrong-answer risk? Uses ticket 002's measured hit-rate to decide.
- **Invalidation** — TTL only, or dependency-driven (a dependency's hash changes
  → key changes → old entry ignored)? What's the rule when dependencies can't be
  enumerated (answer: don't cache — elevate)?
- **Scope** — per-device, per-project, or per-org? The user raised all three;
  cross-org sharing is the payoff Anthropic's prefix cache can't give.

Blocked by 002 (needs the traffic characterization first).
