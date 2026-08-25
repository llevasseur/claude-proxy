---
type: wayfinder-plan
title: Internet Spend 01 — net-server store and read-time model
description: The @agent-proxy/net-server package skeleton — SQLite schema with forward-only migrations, and the pure read-time functions for deltas, gaps, day bucketing, period boundaries and agent classification, fully tested.
tags: [wayfinder, net, sqlite, vitest]
timestamp: 2026-08-25
scope: net
campaign: internet-spend
number: "01"
---

# Internet Spend 01 — net-server store and read-time model

Branch: `task/internet-spend-01-net-store-and-read-model`, cut from `wayfinder/internet-spend`.
Lane: everything under `stacks/net/` plus the one root `.gitignore` entry. Touch nothing under any other stack.

## Package shape

New package `stacks/net/packages/server`, name `@agent-proxy/net-server`,
mirroring the sibling servers' conventions (read
`stacks/codex/packages/core/package.json` and `stacks/claude/server/package.json`
first): `"type": "module"`, no build step, explicit `.ts` import extensions,
`typecheck` via tsc `--noEmit`, tests in vitest living in the package's own
`test/` directory. Runtime dependency budget: `node:sqlite` only — add nothing
else without recording why.

## Criteria

1. **Storage module** (`src/db.ts`) opening a SQLite database at the path
   resolved from `NET_DB_PATH` if set, else anchored off `import.meta.dirname`
   per ADR 0054 (`stacks/net/data/net.sqlite`); create the directory on open.
   Add `stacks/net/data/` to root `.gitignore`.
2. **Forward-only migrations** keyed on `PRAGMA user_version`, from day one,
   per ADR 0047. Migration 001 creates:
   - `sample(timestamp INTEGER, boot_epoch INTEGER, name TEXT, pid INTEGER,
     interface TEXT, bytes_in INTEGER, bytes_out INTEGER)` — raw CUMULATIVE
     counter values, never deltas; one row per (name, pid, interface) per batch.
   - `discontinuity(timestamp INTEGER, kind TEXT CHECK(kind IN
     ('boot','decrease')))` — written by the collector when consecutive samples
     of the same series change boot or decrease.
   - `usage_day(date TEXT, bytes_in INTEGER, bytes_out INTEGER, partial
     INTEGER)` — rebuildable rollup, never trusted at read time.
   - `config(key TEXT PRIMARY KEY, value TEXT)` holding `limitBytes`,
     `resetDay`, `agentPatterns` (JSON-encoded array).
3. **Pure read-time functions**, no Node imports, no clock, no environment —
   deterministic over their inputs exactly like `stacks/*/packages/core`:
   - `computeDeltas(series)` implementing decision internet-spend-002: first
     sample baselines only; `new >= old` yields a delta; `new < old` yields a
     typed decrease discontinuity contributing zero bytes; boot changes are a
     separate discontinuity type taking precedence.
   - `classifyIntervals(samples, {cadenceMs})`: spans > 3× cadence with zero
     delta are known-quiet (no hatch, no partial); spans > 3× cadence with
     nonzero delta are gap intervals — real bytes counted toward totals,
     attributed to no day, hatched, intersecting days partial; sub-threshold
     intervals attribute to their END timestamp's local day.
   - `bucketDays(...)`: local-time day bucketing of attributed deltas over UTC
     epochs (ADR 0030 split), returning one row per calendar day including hole
     days marked not-known, plus the unattributed byte total and the hatch
     spans. Invariant tested: totals + attributed + unattributed = sum of valid
     deltas.
   - `periodBounds(nowLocal, resetDay)`: decision internet-spend-003 — anchored
     day-of-month reset clamped to the month's last day; resetDay 1 = calendar
     month; unset falls back to the 1st.
   - `classifyAgents(name, patterns)`: case-insensitive substring after
     stripping nettop's `.pid` suffix (decision internet-spend-004).
   - Interface filtering: `filterInterfaces(rows, pattern)` default `en*`
     applied at read time (decision internet-spend-001).
4. **Tests** (vitest, beside the package): delta computation including pid
   reuse; boot-reset detection; gap vs known-quiet vs sub-threshold
   classification; period boundaries across DST springs/falls, February with
   resetDay 29/30/31, and resetDay 1; pattern classification incl. `.pid`
   stripping and helper names; interface filtering. Every criterion above has
   at least one test naming it.
5. `pnpm --filter @agent-proxy/net-server typecheck && pnpm --filter
   @agent-proxy/net-server test` green; `biome check .` repo-wide green.

## Verification

`my-command-tools verify --cwd <worktree root>` green on this branch. No server
runs yet — this ticket ships storage and pure functions only, so ticket 02 can
wire collector and HTTP onto them.
