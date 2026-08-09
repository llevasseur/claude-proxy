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
- Its pruner `rm -rf`-ed **whole `archive/<date>/` directories**, and had never fired only
  because the oldest archived day was still inside the window. Once it did, it would have
  deleted the `.audit.json` sidecars along with the bodies, and the substrate's own pruning
  pass (`server/src/db/ingest.ts`) would then have dropped every row derived from that
  vanished directory — both copies of the metrics, gone in one silent step.

The measurement that decides the design: across 16,581 captured request triples the bodies
are ~96% of the bytes (`.request.txt` 3.45 GB, `.md` 3.05 GB) and the sidecars ~1%
(0.07 GB). Every field path that occurs in a sidecar maps to a column in the SQLite
substrate. So keeping the sidecars costs a rounding error and preserves total recovery
(`rm logs/claude-proxy.db && pnpm --filter server ingest`), while evicting the bodies takes
essentially the whole disk win.

## Behavior

### The command

`pnpm --filter server maintain [--apply]` does four things in order:

0. **Reconcile command runs** — under `--apply` only, distil any still-visible command
   runs into `logs/commands/runs.jsonl`. It must run *before* archiving relocates the
   transcripts and bodies it reads. Never fatal, and skipped on a dry run because it
   writes.

1. **Archive** — every file in `logs/` whose name begins with a date strictly before today
   moves to `logs/archive/<that date>/`. Today's logs stay put. Directories are skipped
   rather than moved, and a name with no date prefix is never a candidate; together that
   is what keeps `logs/sessions/`, `logs/commands/`, `logs/.chat/`, `logs/archive/`,
   `logs/suggestion-status.json` and the database where they are.
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

### Keeping everything, on purpose

`RETENTION_DAYS=never` — `off` is accepted for it — turns **eviction** off and nothing
else. Archiving is a separate phase and runs unchanged, so day directories, sidecars and
the archive layout are what they would otherwise be; the plan simply evicts no files, its
`cutoff` is `null`, and the run reports `Evict: off`.

`0` is **rejected** and falls back to the default, because it was the most destructive
value in the file rather than the way to say off: it puts the cutoff on today, which
expires every archived day at once and hands the next `--apply` the whole body corpus.
Nobody has ever meant "evict everything captured before this morning". Before `never`
existed the only way to keep everything was a large magic number — a setting no reader
could tell from a typo, and one no test covered.

### The run prices what it keeps

Eviction is a cost decision, and until now only its reclaim side was reported. Every run —
dry or `--apply` — now also prints what it is **choosing to keep**: bytes surviving the
plan, split into bodies and everything else; the body rate observed over the retained
window; and where that rate leads at 30, 90 and 365 days.

The rate's denominator is the **calendar span** the retained bodies cover, earliest
retained body day through today inclusive, rather than the number of days that happen to
hold a file — a quiet day still spent a day of the window. Under a finite window the
projection is clamped at the steady state that window implies (`rate × RETENTION_DAYS`),
because each new day displaces an expiring one. Under `never` nothing clamps it, and the
projection is the bill for keeping everything. It is all computed by the pure planner from
the listing it already walks with sizes, so it costs arithmetic rather than a second pass
over the disk.

That is what makes `never` a defensible informed setting, and the scheduled 21:00 job's log
a **growth record** rather than only a reclamation record.

### Eviction as a typed state

A missing body used to throw "request file not found", which reads the same as a bug. Now
`/api/context/detail`, `/api/context/message` and `/api/context/tool` return a discriminated
union: either the body, or `{ evicted: true, day, retentionDays, retained }` carrying the
audit sidecar's metrics. The dashboard renders **"Body evicted after 30 days — metrics
retained"** with the retained token counts, byte totals and tool table. A body that was
never captured at all still 404s, so real bugs stay visible.

Those routes also resolve a body inside `logs/archive/<date>/`, not just the live directory.
This is load-bearing: archiving had stopped, so every body was live, and once the job starts
moving days again a drill-down that only looked in `logs/` would 404 every past day. The
archive candidate comes from the filename's own date prefix, so it is one lookup, not a scan.

`/api/skim` and `/api/skim/trend` report `meta.bodiesEvicted` — requests counted from their
sidecar whose body is gone. Both read backings derive it from the same disk observation, so
the parity harness stays byte-identical.

### The scheduled job

`scripts/com.llevasseur.claude-proxy.maintain.plist` is the reviewable copy of the launchd
agent: label `com.llevasseur.claude-proxy.maintain`, 21:00 daily, `--apply`, with `LOG_DIR`,
`RETENTION_DAYS=30` and `TIMEZONE=America/Toronto` pinned in its environment, output to
`~/.claude-usage/logs/maintain.log`. It replaces `com.llevasseur.claude-usage-summary`,
which is unloaded. Losing that job's model-written narrative prose is accepted; the digest
is the part worth keeping.

## Acceptance criteria

- `pnpm --filter server maintain` with no flags changes nothing on disk and prints the plan.
- `RETENTION_DAYS=never` (or `off`) evicts nothing while archiving is unchanged; `0` is
  rejected and falls back to 30.
- Every run prints the bytes it is keeping, the observed per-day body rate, and the growth
  that follows from it.
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
