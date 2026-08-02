---
type: adr
title: Adopt SQLite as the query substrate over the log files
description: Index the audit sidecars into a disposable SQLite view so reads can be indexed, joined, and aggregated, while logs/ stays the source of truth.
tags: [architecture, backend, storage, performance]
timestamp: 2026-08-02
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
  total-recovery path is `rm logs/claude-proxy.db && pnpm --filter server ingest`
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

Every route flip is gated on a **parity harness**: the file-backed and DB-backed
readers sit behind one `SidecarSource` interface, and a test replays each wired
route against the whole archive both ways and asserts byte-identical JSON — the
full payload, never a row count. Legitimate diffs are allowed only as explicitly
named normalizations; a diff nobody can name is treated as a bug in the
substrate. A **shadow mode** (`SHADOW_DB=1`, off by default) serves from the
files exactly as today and computes the DB answer alongside, logging any
mismatch without ever touching the response.

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
  reversible per route rather than as one flip.
- Slice 6 — the proxy writing rows and content-addressed blobs, authored state
  moving in, `/revive` taught the DB — is the irreversible step and is
  deliberately left unspecified until slice 5 proves the schema. See
  [Map: SQLite as the query substrate](../wayfinder/map-sqlite-substrate.md).
