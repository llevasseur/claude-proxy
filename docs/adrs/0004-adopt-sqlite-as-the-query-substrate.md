---
type: adr
title: Adopt SQLite as the query substrate over the log files
description: Index the audit sidecars into a disposable SQLite view so reads can be indexed, joined, and aggregated, while logs/ stays the source of truth.
tags: [architecture, backend, storage, performance]
timestamp: 2026-08-02
scope: claude
provenance:
  - repo: claude-proxy
    number: "0004"
    file: docs/adrs/0004-adopt-sqlite-as-the-query-substrate.md
ratified: true
needs-human: false
---

# Adopt SQLite as the query substrate over the log files

## Status

Accepted. Extends [ADR 0002](0002-monorepo-with-pnpm-tanstack-and-node.md),
which made `server/` an API over captured logs; this record changes how those
logs are *read*, not what they are.

## Context

`logs/` is doc-shaped. Every read path is a full `readdir` plus `readFile` scan
rebuilt per request — `server/src/logs.ts`, `server/src/sessions.ts`,
`server/src/command-runs.ts` all do the same walk with different filters. That
was fine when the question was "what happened today". It stops being fine for
the questions the dashboard now asks: which tools burn the most tokens across
every session, how a metric moves over thirty archived days, which sessions
share a device. Those are joins and aggregations, and a directory listing
cannot serve them without re-reading everything each time.

The obvious answer is a database. The non-obvious part is which one, and what it
is allowed to be authoritative about.

## Decision

**SQLite, in WAL mode, via `node:sqlite`, as a materialized view over `logs/`.**

- **SQLite rather than Postgres.** This is a single-user localhost tool whose
  value proposition is clone-and-run. Postgres would add a service to install,
  start, and keep running before the dashboard shows anything — it would make
  the project meaningfully harder to run in exchange for concurrency and network
  access that a one-person local tool does not use.
- **`node:sqlite` adds no dependency, so the project's zero-dependency stance is
  untouched and this ADR is not a dependency overrule.**
- **The one real platform change is the engines floor**, raised from `>=18` to
  `>=22` in the root `package.json`, because `node:sqlite` is not in Node 18.
  Node 18 went EOL in April 2025 and Node 20 in April 2026, so the old floor was
  already stale.
- **Raw SQL with prepared statements**, schema version in `PRAGMA user_version`.
  No ORM, no query builder — the queries are few, fixed, and easier to reason
  about as SQL than as a fluent API.
- **The DB is a disposable view first.** `logs/` remains the sole source of
  truth; every table is fully reconstructible by re-ingesting, so the supported
  total-recovery path is `rm logs/claude-proxy.db && pnpm --filter @agent-proxy/claude-server ingest`
  and nothing is lost. Ingest is idempotent and watermarked, so "ran twice" and
  "died halfway" are both harmless. The watermark is keyed on the sidecar
  filename stem for the audit sidecars, which are written once and never
  changed; the session transcripts are the mutable part of `logs/` — the proxy
  appends to one for the life of the run it records — so they carry a *per-file*
  watermark (`bytes` + `modified`) instead, an append always moving the size.
  Becoming
  the source of truth is a *later, staged* decision — the view has to be proven
  byte-identical across every archived route first.
- **Authored state stays out.** `logs/suggestion-status.json` and the device
  settings file are not derivable from the logs, so a disposable view may not
  hold the only copy of them. They remain JSON files exactly as they are.
- **Structured data only.** The `.md` and `.request.txt` bodies — roughly
  1.2 GB/day, ~99% of the bytes — stay on disk untouched. The DB stores nullable
  pointers to them plus an explicit `blob_evicted` flag, so "retention deleted
  the body, we kept the metrics" is a queryable fact rather than a dangling path.
- **The proxy is not touched.** `proxy/proxy.mjs` is load-bearing: if it breaks,
  Claude Code itself stops working. The server does all ingest. This is a
  blast-radius decision, not a dependency-purity one — the proxy writing rows
  directly is a plausible endpoint, just not one to attempt before the schema
  has been proven by something that cannot take Claude Code down with it.

Every route flip was gated on a **parity harness**: the file-backed and DB-backed
readers sit behind one `SidecarSource` interface, and a test replayed each wired
route against the whole archive both ways and asserted byte-identical JSON — the
full payload, never a row count. Legitimate diffs were allowed only as explicitly
named normalizations; a diff nobody could name was treated as a bug in the
substrate. That replay was also **timed**, against recorded per-route medians
with headroom, so a route that kept answering the same bytes far more slowly
failed the suite rather than going unnoticed.

> **The parity gate has since been removed.** It did its job: every slice below
> landed green, the substrate
> is the trusted read path, and the harness had nothing left to prove. The
> equivalence test, the recorded time and size budgets, and the
> `ROUTE_BUDGETS` / `PARITY_DAYS` switches are all gone. **The `SidecarSource`
> seam and the file-scan backing are not** — `fileSource` is still there, and
> `DB_READS=0` still puts every route back on the scan.

What remains as a live check is **shadow mode** (`SHADOW_DB=1`, off by default):
it serves the response as usual and computes the *other* backing's answer
alongside, logging any mismatch without ever touching the response. The route
registry the harness declared, `PARITY_ROUTES` in `server/src/parity.ts`, also
remains — it is how the wired routes and their cases are enumerated.

## Hard constraint — `/revive` reads the session files directly

The `/revive` command (`~/.claude/commands/revive.md`) recovers an interrupted
run by reading `logs/sessions/*.md` **straight off disk**, located through the
`CLAUDE_PROXY_STORE` and `CLAUDE_PROXY_ARCHIVE` environment variables. It goes
through no API and no database.

So a later stage **must not stop writing those files** until `/revive` has been
taught to read the DB. Doing it in the other order would disable the migration's
own recovery mechanism at exactly the point the migration is most likely to need
it — a failed cutover would take out the tool for resuming from a failed
cutover.

## Consequences

- Aggregate questions become indexed queries instead of full scans, and new
  ones ("group tool spend by name across every session") stop requiring a new
  scan path.
- There is a second copy of the log data on disk, which can be stale or corrupt.
  Both are answered the same way: delete it and re-ingest. Nothing else recovers
  the file, because nothing else needs to.
- The project now requires Node 22. That is the only thing a contributor has to
  change about their machine.
- Reads stay file-backed until parity is green for a route, so the migration is
  reversible per route rather than as one flip. Slice 5 has since flipped them:
  the substrate serves by default and `DB_READS=0` puts every route back on the
  scan. That is still reversible in the sense this decision meant — the log
  files are untouched, so the fallback needs no migration to undo.
- Slice 6 was left unspecified until slice 5 proved the schema. It was then
  specified as retention and lifecycle ownership, **not** the cutover — see the
  next section. The disposable view is therefore permanent architecture, not a
  staging state. See
  [Map: SQLite as the query substrate](../wayfinder/map-sqlite-substrate.md) and
  [Retention lifecycle](../features/retention-lifecycle.md).

## Considered and rejected — the proxy as writer

Slice 6 was sketched above as the irreversible cutover: the proxy writing rows
directly, request bodies moving into content-addressed blobs, authored state
(suggestion status, chat) moving into the DB, and `/revive` taught to read it.
With slice 5 shipped and the corpus measured, that cutover was **rejected**.

The measurement, across 16,581 captured request triples:

| What | Bytes | Share |
|------|-------|-------|
| `.request.txt` bodies | 3.45 GB | 51% |
| `.md` bodies | 3.05 GB | 45% |
| `.audit.json` sidecars | 0.07 GB | 1% |
| `logs/sessions/` transcripts | 6.8 MB | ~0% |

And the sidecars are **losslessly** represented in the schema: across 1,500 live
sidecars, every field path that occurs — timestamp, model, endpoint, status, all
five token fields, all four request fields, tools, all six session fields, all
four skim fields, all 15 distinct rate-limit headers — maps to a column.

That combination is what kills the cutover. Simply **evicting the bodies past a
retention window buys 98.6% of the disk win at zero irreversibility**: the
sidecars stay, so `rm logs/claude-proxy.db && pnpm --filter @agent-proxy/claude-server ingest` still
reconstructs the whole database from files, and no data lives only inside SQLite.
Content-addressed blobs would buy the remaining 1.4% by making the DB the sole
home of data that cannot be re-derived — trading the recovery path for a rounding
error.

The same reasoning disposes of the rest of the sketch. Making the proxy a writer
puts a database write on the request path of the thing that must never break, in
exchange for freshness the ingest already provides. Moving authored state in
gives up plain-file editability for tables nothing queries in aggregate. And
teaching `/revive` to read the DB removes the property that makes it trustworthy:
it works off disk, with no server and no schema, which is exactly when a run needs
recovering.

What shipped instead is retention and lifecycle ownership: this repo archives and
evicts its own logs, keeps every sidecar forever, and reports an evicted body as a
typed state carrying the retained metrics. The campaign is complete at slice 6;
the substrate stays a disposable view of the files, permanently.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
