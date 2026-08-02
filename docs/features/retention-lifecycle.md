---
type: feature
title: Retention lifecycle
description: This repo owns its own log lifecycle — it archives past days, evicts request bodies at 30 days, keeps every audit sidecar, and reports eviction as a typed state rather than a missing file.
tags: [retention, logs, sqlite, maintenance]
timestamp: 2026-08-02
---

# Retention lifecycle

## Summary

`pnpm --filter server maintain` archives past-day logs, evicts request **bodies** older
than `RETENTION_DAYS` (default 30) from `logs/archive/<date>/`, and prints the day's
digest. Every `.audit.json` sidecar is kept forever, so an evicted day still answers
usage, tools, trends and summary byte-identically. The command is a **dry run by default**
and only touches the disk with `--apply`.

## Motivation

Nothing in this repo had ever deleted or archived a log. Both jobs were done by an
out-of-repo script (`usage-summary.ts`, launchd job `com.llevasseur.claude-usage-summary`),
which had two problems:

- It had **stopped working**. It called an external agent over HTTP before archiving, that
  call started failing, and archiving never ran — leaving thousands of past-day sidecars
  piled up in the live directory.
- Its pruner `rm -rf`-ed **whole `archive/<date>/` directories**. It had never fired only
  because the oldest archived day was still inside the window. Once it did, it would have
  deleted the `.audit.json` sidecars along with the bodies, and the substrate's own pruning
  pass (`server/src/db/ingest.ts`) would then have dropped every row derived from that
  vanished directory. Both copies of the metrics, gone in one silent step.

The measurement that decides the design: across 16,581 captured request triples the bodies
are ~96% of the bytes (`.request.txt` 3.45 GB, `.md` 3.05 GB) and the sidecars ~1%
(0.07 GB). Every field path that occurs in a sidecar maps to a column in the SQLite
substrate. So keeping the sidecars costs a rounding error and preserves total recovery
(`rm logs/claude-proxy.db && pnpm --filter server ingest`), while evicting the bodies takes
essentially the whole disk win.

## Behavior

### The command

`pnpm --filter server maintain [--apply]` does three things in order:

1. **Archive** — every file in `logs/` whose name begins with a date strictly before today
   moves to `logs/archive/<that date>/`. Today's logs stay put. A name with no date prefix
   is never a candidate, which is what keeps `logs/sessions/`, `logs/commands/`,
   `logs/.chat/`, `logs/suggestion-status.json` and the database where they are.
2. **Evict** — inside `logs/archive/<date>/` for every day strictly older than
   `today − RETENTION_DAYS`, the `.md` and `.request.txt` files are deleted. `.audit.json`
   is never evicted and **the day directory is never removed** — it still holds the
   sidecars. Eviction only ever runs inside `archive/`, never in the live directory.
3. **Digest** — prints the day's summary through the existing `buildSummary` path. No
   model call, no network.

Without `--apply` it prints exactly what it would do — counts, days, and bytes — and
changes nothing.

`RETENTION_DAYS` (default 30) is measured on the log's **own date**, the `YYYY-MM-DD` its
filename starts with. `TIMEZONE` sets the day boundary, defaulting to the repo's reporting
zone.

The planner (`server/src/retention.ts`) is a pure function from a listing to a plan, so it
is tested over a fixture corpus and no test can delete a real log.

### Eviction as a typed state

A missing body used to throw "request file not found", which reads the same as a bug. Now
`/api/context/detail`, `/api/context/message` and `/api/context/tool` return a discriminated
union: either the body, or `{ evicted: true, day, retentionDays, retained }` carrying the
audit sidecar's metrics. The dashboard renders **"Body evicted after 30 days — metrics
retained"** with the retained token counts, byte totals and tool table. A body that was
never captured at all still 404s, so real bugs stay visible.

Those routes also resolve a body inside `logs/archive/<date>/`, not just the live directory.
This is load-bearing. Archiving had stopped, so every body was live; once the job starts
moving days again, a drill-down that only looked in `logs/` would 404 every past day.
The archive candidate comes from the filename's own date prefix, so it is one lookup, not a
scan.

`/api/skim` reports `meta.bodiesEvicted` — requests counted from their sidecar whose body is
gone. Both read backings derive it from the same disk observation, so the parity harness
stays byte-identical.

### The scheduled job

`scripts/com.llevasseur.claude-proxy.maintain.plist` is the reviewable copy of the launchd
agent: label `com.llevasseur.claude-proxy.maintain`, 21:00 daily, `--apply`, output to
`~/.claude-usage/logs/maintain.log`. It replaces `com.llevasseur.claude-usage-summary`,
which is unloaded. Losing that job's model-written narrative prose is accepted; the digest
is the part worth keeping.

## Acceptance criteria

- `pnpm --filter server maintain` with no flags changes nothing on disk and prints the plan.
- `--apply` archives past days, leaves today's logs in `logs/`, and reports bytes reclaimed.
- No `.audit.json` is ever deleted, and no `archive/<date>/` directory is ever removed.
- `logs/sessions/`, `logs/commands/`, `logs/.chat/` and `logs/suggestion-status.json` are
  untouched — `logs/sessions/` is what keeps `/revive` working off disk.
- An evicted day serves usage, tools, trends and summary byte-identically to before.
- The context routes return the evicted marker with retained metrics; a never-captured file
  still 404s.
- The parity harness stays green.

## Related

- [ADR 0004 — Adopt SQLite as the query substrate](../adrs/0004-adopt-sqlite-as-the-query-substrate.md)
- [Wayfinder map — SQLite substrate](../wayfinder/map-sqlite-substrate.md)
