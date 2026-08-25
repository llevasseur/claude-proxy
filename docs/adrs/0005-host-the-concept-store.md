---
type: adr
title: Host the concept store as a Cloudflare Worker over D1
description: Move the /teach corpus out of logs/concepts.jsonl and into a hosted append-only D1 database, reachable by agents over MCP from any machine, with a daily git backup as the reversibility guarantee.
tags: [architecture, backend, storage, mcp, cloud]
timestamp: 2026-08-07
---

# Host the concept store as a Cloudflare Worker over D1

## Status

Accepted. Departs from [ADR 0004](0004-adopt-sqlite-as-the-query-substrate.md)
for one dataset — concepts — and leaves that ADR governing everything else.
Extends [ADR 0002](0002-monorepo-with-pnpm-tanstack-and-node.md) with a fifth
workspace package that does not run on Node.

## Context

`/teach` writes a concept to `logs/concepts.jsonl` in whichever claude-proxy
checkout the machine happens to have. That file is the whole corpus, and it is
local. Three things follow, and all three are already happening.

The corpus is stranded per device. Concepts taught on the work laptop are
invisible on the personal one and the other way round. Worse than invisible:
`/teach` resolves its target through `CLAUDE_PROXY_STORE`, and on a machine
where that variable is unset the command still runs, still produces its
sentence, and silently saves nothing. The store being unreachable is by design
non-fatal, which is right, but it means the failure mode is quiet loss.

Agents cannot read it at all. The corpus is the one body of knowledge in this
system that an agent has no way to query — `okq` gives agents ranked search over
`docs/`, and there is no equivalent for the thing the user has actually been
teaching themselves. An agent about to research a term the user defined for
themselves six months ago has no way to find that out.

And the trajectory points away from local. The intent is for agents working in
**orbs** — throwaway cloud boxes that keep no copy of the user's files — to
reach the same corpus. A file on a laptop cannot serve that; nothing in an orb
has a filesystem worth reading.

## Decision

Stand up `services/concepts`: a Cloudflare Worker over a D1 database, holding
the corpus and serving it over REST and MCP. The database becomes the source of
truth for concepts. `logs/concepts.jsonl` is retired.

**D1, because it is SQLite.** The ranking that makes `okq` useful is BM25, and
SQLite's FTS5 provides `bm25()` directly. Choosing Postgres would have meant a
different ranking story and a different local-test story; choosing D1 means the
tests run the production SQL — the same migration file, the same virtual table,
the same ranking function — through `node:sqlite` in memory, with no Cloudflare
account and no network. That is not a mock standing in for the database. It is
the same engine reached through a different handle, and it is the single
strongest reason for this choice.

**Append-only, newest-per-term on read.** A `/teach` never overwrites. Re-teaching
a term inserts a version, and reads resolve the newest one unless a caller asks
otherwise. How an understanding changed is data, not noise, and an append-only
table is also the shape that makes a write safely retryable.

**Ids are derived, not random.** A row id is a ULID whose timestamp half comes
from `savedAt` and whose remaining 80 bits are a hash of the record itself. Ids
therefore sort chronologically, writes are idempotent without a dedupe pass, and
an export followed by an import reproduces every id exactly — which is what makes
the backup below a real restore rather than an approximation.

**One token, not two.** The design carried a read token and a write token until
the decision to let orbs write. An orb needs to save concepts, so any token that
reaches an orb is a write token; a second token with identical reach is
bookkeeping wearing the costume of a boundary. One `CONCEPTS_TOKEN` is honest
about the actual trust boundary, which is "a machine the user controls".

**MCP is hand-rolled.** `proxy/` ships zero runtime dependencies and
`@claude-proxy/core` ships none either. The official SDK would buy transport
plumbing this service does not use — session ids, SSE resumption,
server-initiated messages — and would cost a dependency in the request path of
the only always-on component in the system. Three tools and four JSON-RPC
methods came to less code than configuring the SDK would have.

**Protocol revisions `2025-06-18` and `2026-07-28`, both stateless.** The newer
revision replaced the `initialize` handshake with a version declared on every
request, and removed protocol-level sessions and the GET stream outright. Those
removals describe what this service already was: it holds nothing between
requests and answers each one from a single JSON body. Codex still negotiates
`2025-06-18`, however, so the Worker also answers that revision's `initialize`
and `notifications/initialized` messages. It returns no session id and retains
nothing from either message; subsequent requests declare their negotiated
version in the header. Compatibility therefore adds a dispatch path, not a
session concept. A client that asks for any other revision gets an
`UnsupportedProtocolVersionError` naming both revisions the server speaks.

**No hosted UI.** This is an agent interface. The dashboard stays in
`apps/admin/`, reading through `server/`.

## Consequences

**ADR 0004's principle is deliberately broken here, and paid for.** That ADR says
files are truth and the database is a disposable view. For concepts, the
database becomes truth: there is no file to rebuild from, and dropping the
database loses data. The payment is a cron trigger that commits the entire
corpus as JSONL to a private git repo every night, comparing git blob shas so an
unchanged day makes no commit. The format is the same JSONL the rest of the
toolchain already reads, and the import path is the ordinary write path, so a
restore is a supported operation rather than a recovery project. Worst case is
one day of concepts. ADR 0004 continues to govern sessions, audits and usage —
this is one carve-out with a stated price, not a reversal.

**The monorepo gains a non-Node runtime.** `services/concepts` runs on workerd,
not Node, which is a real departure from ADR 0002's four Node packages. It is
contained: `@claude-proxy/core` has no runtime dependencies and so runs there
unchanged, which is why the domain model is imported rather than duplicated.
Cloudflare's types are imported explicitly instead of loaded as ambient globals,
so the same `src/` also typechecks under Node for the test pass.

**A network dependency enters `/teach`.** It posts to the Worker and, as before,
treats an unreachable store as non-fatal — the sentence and the clipboard still
happen. The failure mode is unchanged in shape but no longer silent about its
cause.

**A cost and an account become load-bearing.** Cloudflare's free tier covers a
corpus of this size comfortably, but the system now depends on an account that
can be suspended. The daily backup is the mitigation and is the reason the
dependency is acceptable.

**This lands in three sequenced steps, with no dual-write.** The service ships
first (this ADR), then `/teach` is repointed in the `my-command` repo and synced
to every device, and only then does claude-proxy retire the local file and
schema. Deleting `logs/concepts.jsonl` before every device has the updated
`/teach` would silently drop concepts, so the ordering is a correctness
requirement rather than a convenience.

## Considered and rejected

**Keep the file and sync it.** Dropbox, a git repo, or a sync daemon over
`logs/concepts.jsonl`. It solves the two-laptop problem and none of the others:
an orb still has no filesystem to sync into, and an agent still has nothing to
query. It also trades a clear failure mode for merge conflicts in an append-only
file.

**Postgres via a managed provider.** More operationally familiar, and the
correct answer if this data were relational and large. It is neither. Giving up
`bm25()` — the exact ranking the tooling already uses elsewhere — to gain
features this corpus will not use was a bad trade, and it would have put a live
database between the tests and the SQL they exercise.

**Use the official MCP SDK.** Reconsidered rather than dismissed: it is the
right default for a server with real transport needs. This one answers every
request immediately from a single JSON body, so the SDK's surface is nearly all
unused, and the dependency-free posture of the surrounding packages is worth
more than the boilerplate saved.

**Serve only `2026-07-28`.** Originally accepted because the newer protocol is
the service's natural shape. Reversed when the Codex client proved it still
negotiates `2025-06-18`. The premise that dual support requires sessions was
also too strong: this server can complete the older handshake without issuing
a session id or retaining connection state.

**Two tokens, read and write.** Held until the orb decision made it fictional.
Recorded here because the reasoning that justified it — least privilege for
read-only consumers — is sound, and if orbs ever stop writing, this is the
decision to revisit first.
