---
type: adr
title: Host the ideas ledger on the existing operator Worker
description: Move the ideas ledger out of logs/ideas.json and into the D1 database the concept store already runs on, as an append-only event log replayed through packages/core, with claiming promoted to an atomic conditional write and no local fallback.
tags: [architecture, backend, storage, mcp, cloud, ideas]
timestamp: 2026-08-10
scope: claude
provenance:
  - repo: claude-proxy
    number: "0006"
    file: docs/adrs/0006-host-the-ideas-ledger.md
ratified: true
needs-human: false
---

# Host the ideas ledger on the existing operator Worker

## Status

Accepted. Extends [ADR 0005](0005-host-the-concept-store.md) from one hosted
dataset to two, on the same Worker, the same database and the same token.
Restates — rather than widens — that ADR's carve-out from
[ADR 0004](0004-adopt-sqlite-as-the-query-substrate.md).

## Context

`<logDir>/ideas.json` is the ledger of what somebody proposed building and what a
human decided about it. It is device-local, and
[the feature doc](../features/ideas-ledger.md) has carried the consequence as an
open question since it was written: "Syncing it would need a home that is not
`logs/`."

Three things follow from that, and unlike the concept store's version of this
problem, two of them are worse rather than merely equivalent.

**An idea accepted on one machine is invisible on the other.** `accepted` is the
one status `/improve` acts on, so a sign-off given on the laptop is a sign-off
the desktop cannot act on and cannot see.

**Dedupe is the point of the store, and it is the part that breaks first.**
`similarIdeaSlugs` exists because a near-duplicate under a different name defeats
the slug key, and a rejection reason is described in the feature doc as "the most
valuable row in the file". A proposal made on one device is checked against that
device's ledger alone — so the idea another machine already rejected, with the
reason written down, comes back as new. The store's whole job is to record what
was already considered, and a per-device ledger can only record what *this*
device considered.

**Claiming coordinates writers that cannot see each other.** `claimed` exists
because two runs built `archive-aware-window-reader` eleven minutes apart. The
claim narrows that window to one read-modify-write — which the feature doc
concedes is "narrowed, not eliminated" — and that residue was tolerable while one
agent at a time wrote one file. It stops being a residue once the ledger is
genuinely shared, because then the two racing writers are the normal case rather
than the pathological one.

## Decision

Extend the existing Worker with an ideas dataset. **No second service.**

`services/concepts/` is named after its first dataset, not its scope: its
`wrangler.jsonc` deploys a Worker called `operator` over a D1 database called
`operator-db` bound as `operator_db`. The auth, the `Db` port, the derived-ULID
ids, the `/mcp` dispatch and the nightly backup are all dataset-agnostic already.
A second Worker would mean a second deploy, a second token, a second cron and a
second backup repo, to reach the same database from the same clients.

Four decisions depart from how concepts was done. They are departures on purpose,
and each one is a place where copying the precedent would have been wrong.

**No silent local fallback — an unconfigured device refuses the write.**
`remoteConceptStore()` returns `null` and the local file answers, which is right
for concepts: the corpus is additive, and a device that saves nowhere loses one
concept. It is exactly wrong here. An unconfigured device falling back to
`logs/ideas.json` would keep a *second, divergent, complete-looking ledger* — and
re-propose everything the shared one already rejected, which is the failure ADR
0005 was written to kill, reappearing through the mechanism meant to be its
mitigation. So `requireRemoteIdeasStore()` throws, naming the two variables it
wants. A device that cannot reach the ledger does no ideas work; it does not do
ideas work against a private copy.

**An append-only event log, replayed through `packages/core`.** The store holds
`add`, `mark`, `file` and `comment` events, each carrying the same derived ULID
idempotency concepts uses — the id is a hash of the event, so a replayed write
lands on the row it already wrote. A read replays them oldest-first through the
existing `applyIdeaAdds`, `applyIdeaMarks`, `applyIdeaFilings` and
`applyIdeaComments`. **No status rule, no evidence rule and no claim rule is
restated in SQL.** `packages/core/src/ideas.ts` stays the only place the
semantics live, which is what keeps the CLI, the dashboard, the Worker and the
MCP tools from drifting into four dialects of one ledger. The event log is also
what makes the ledger conflict-free across devices in the way the file never
was — two devices appending two events is not a conflict, where two devices
rewriting one JSON blob is.

**Claiming is an atomic conditional write, and it is the one deliberate
exception.** A claim is a row in `idea_claim`, and taking one is a single
`UPDATE … WHERE holder IS NULL OR holder = ? OR (pr IS NULL AND at < ?)` whose
`changes` count decides the winner. Two runs racing now produce one winner and
one refusal from the database rather than two winners from two reads. The
exception is contained in two ways: the cutoff is computed in TypeScript from
`IDEA_CLAIM_TTL_MS`, and the "a claim carrying a PR never expires" rule is the
`pr IS NULL` conjunct — so even the SQL borrows the rule rather than restating
it, and the *status* precondition (only an `accepted` idea may be claimed) stays
in core, checked before the gate. The gate is mutual exclusion, not policy.

**The stream polls, and the SSE contract does not change.**
`/api/ideas/stream` watched the log directory, and there is no file to watch once
the ledger is remote. `server/` polls the Worker's export on an interval and
diffs, emitting an `update` only when the payload actually changed — the same
dedupe the watch source already did. **No Durable Objects and no WebSockets**,
which would reintroduce the per-connection state ADR 0005 rejected outright, to
serve a page that refreshes every few seconds. The dashboard is untouched.

**The backup covers both datasets.** The nightly cron commits the ideas export
beside `concepts.jsonl` in the same private repo.

## Consequences

**ADR 0004's carve-out is restated, not widened.** ADR 0004 says files are truth
and the database is a disposable view. That is still true of sessions, audits and
usage, which are derived from captured files and can be rebuilt by deleting the
database. It is not true of concepts, and it is now not true of ideas: both are
*authored* state that exists nowhere else, so for both the database is truth and
dropping it loses data. The price is the same price, paid by the same mechanism —
a nightly commit of the full export to a private git repo, compared by git blob
sha so an unchanged day makes no commit. **Two carve-outs with one stated price,
not a reversal.** The test for whether a third dataset belongs here is the one
these two pass: it is authored rather than derived, and there is no file to
rebuild it from.

**A network dependency enters the ideas CLI, and it is fatal by design.** Every
other network dependency in this system degrades quietly on purpose; this one
does not, per the first decision above. `pnpm --filter @agent-proxy/claude-server ideas list` on an
unconfigured device fails with a message naming `IDEAS_URL` and `IDEAS_TOKEN`,
rather than printing an empty ledger.

**The claim race is closed rather than narrowed**, which retires an open question
the feature doc carried. The remaining honest limit is unchanged and is not about
atomicity: a holder is free text, so two runs choosing the same holder string
still read each other's claim as their own idempotent re-claim.

**This lands in three sequenced steps, and the ordering is a correctness
requirement.** The service ships first (this ADR). Then `/ideate` and `/improve`
are repointed and synced to every device — those command files live in the
`my-command` repo under `~/.claude/commands/`, outside this checkout, which is
why the feature doc's out-of-repo command boxes are not closed by anything here.
`/improve` has since been repointed and its box records that; the rest stay open.
**Only then** is `logs/ideas.json` retired. Deleting it before
every device has the updated commands silently drops ideas, so this change
deliberately does not delete it: it stops being read, and a `seed:ideas` importer
pushes each device's existing file into the hosted ledger first. Because ids are
derived from event content, running that importer on every device — and running
it twice — converges rather than duplicating.

## Considered and rejected

**A second Worker for ideas.** The obvious reading of "one service per dataset",
and it buys nothing here: the same clients, the same trust boundary, the same
database. It costs a second deploy, token, cron and backup repo, and it would
have made the shared halves — auth, the `Db` port, ULID derivation, the MCP
dispatch — either duplicated or extracted into a package for two consumers.

**Keep the file and sync it.** Rejected for concepts in ADR 0005, and the
rejection is stronger here rather than merely inherited. `concepts.jsonl` is
append-only, so a sync conflict is at least rare and mechanically resolvable.
`ideas.json` is a **single JSON blob rewritten whole on every status change**, so
two devices that each accept one idea conflict on the same bytes essentially
every time. Union-merging it is not available the way it is for `CHANGELOG.md`,
because the file's shape is a map rather than a list of independent lines: the
merge would have to understand which of two `updated` timestamps won, which is
the ledger's semantics smuggled into a merge driver.

**Rows for entries rather than an event log.** A `idea` table with a `status`
column is the smaller schema and reads without replay. It was rejected because it
puts the status machine in SQL: `applyIdeaMarks` drops the claim on every mark
but `shipped`, `applyIdeaFilings` refuses to move a `command-gap` idea out of
`commands`, and a `rejected` note is load-bearing for dedupe. All of that would
have to be restated in the Worker and kept in step with `packages/core` by hand.
Replay costs a full scan on read, which at this corpus's size is nothing, and it
buys the guarantee that the hosted ledger and the local one cannot disagree about
what a mark means.

**A lease with a heartbeat, instead of the six-hour TTL.** The TTL is a judgement
rather than a measurement — that is recorded as an open question and stays open.
A heartbeat would close it properly and brings its own stuck states, and the
atomic gate above already removes the failure that actually cost something. This
is the decision to revisit first if runs start losing claims mid-flight.

**Durable Objects or a WebSocket for the stream.** The direct answer to "the
watch has nothing to watch", and the one ADR 0005 already priced: it reintroduces
per-connection state on the always-on component, for a dashboard list. Polling
with a diff produces the same SSE frames the watch source produced.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
