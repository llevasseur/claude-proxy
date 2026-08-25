---
type: adr
title: The server accepts narrowly-scoped local writes
description: One database and one controller per proxy, n for n, with mid-stream disconnects recorded by the hosting proxy alone.
tags: [monorepo, backend, architecture, storage, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# The server accepts narrowly-scoped local writes

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.
Extends [0003](0003-allow-narrowly-scoped-writes-in-the-local-server.md) — which allowed an
explicit, origin-checked set of local writes in claude-proxy's server — to the fused
repository, and adds the two rules below that only exist once there are three stacks.

## Context

0003 settled the principle for one stack: log analysis stays read-only, and a named,
origin-checked set of local writes is allowed. Fusion raises two questions 0003 never had
to answer, because both are about there being more than one proxy.

## Decision

**The principle from 0003 carries over unchanged.** Reads over captured traffic are
read-only; writes are an explicit, enumerated, origin-checked set, not a general write API.

### One database and one controller per proxy, n for n

**Each proxy owns exactly one database and exactly one controller writing to it.** Three
proxies, three databases, three writers — n for n, never a shared store and never two
writers against one file.

The reason is blast radius. A shared store means one proxy's writer can block, corrupt, or
lock out the others, and one store going down takes the whole dashboard with it. With one
store per proxy, **a store going down costs only its own provider's pages**: the picker
still works, the other providers still stream, and the failure is legible as "this provider
is unavailable" rather than as a dead dashboard.

It also removes the write-contention question outright. SQLite with a single writer per
file needs no coordination protocol between proxies, because there is nothing to
coordinate.

### A mid-stream disconnect is the hosting proxy's to record

**A stream that drops mid-response is recorded `interrupted` by the hosting proxy alone** —
the proxy that was serving it. No other proxy may write that record, and no shared observer
infers it from the outside.

**If that same proxy resumes the stream, it records `resumed`.** Resumption is a fact about
the same connection on the same proxy; a different proxy picking up related traffic is new
traffic, not a resumption.

**Tokens counted so far are kept, and the record is flagged `usage_complete: false`.**
Discarding them loses real metered usage that was really consumed; keeping them unflagged
would let a truncated count aggregate as though it were whole. The flag is what makes the
partial count safe to keep — it propagates into aggregates the same way an unavailable cost
does under [0044](0044-every-model-gets-a-price-row.md).

## Consequences

- Three databases to back up, migrate and reason about, and no cross-provider join at the
  storage layer. A question spanning providers is answered by querying each and combining
  above the store.
- Provider isolation is real rather than conventional: the dashboard degrades per provider.
- Every usage aggregate must handle `usage_complete: false`, so a partial record is visible
  as partial rather than silently rolled in.
- An interrupted stream that is never resumed stays `interrupted` permanently. That is a
  true record of what happened, not a state to clean up.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
