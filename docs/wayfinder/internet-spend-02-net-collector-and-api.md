---
type: wayfinder-plan
title: Internet Spend 02 — net-server collector and HTTP API
description: The hourly nettop collector, config module, CORS'd HTTP API on 8531, the fourth zellij layout, and the AGENTS.md stack-table row.
tags: [wayfinder, net, collector, http]
timestamp: 2026-08-25
scope: net
campaign: internet-spend
number: "02"
---

# Internet Spend 02 — net-server collector and HTTP API

Branch: `task/internet-spend-02-net-collector-and-api`, cut from `wayfinder/internet-spend`.
Lane: `stacks/net/**`, `.zellij/net-server.kdl` (new), `.zellij/README.md`,
root `AGENTS.md` (one table row + one prose line), root `CHANGELOG.md`.
Requires ticket 01 merged (storage + pure functions).

## Criteria

1. **Collector** (`src/collector.ts`): a resident `setInterval`-driven timer
   inside the server process waking hourly (decision internet-spend-005 — no
   launchd, no second process). Each wake runs `nettop -L 1` once (NO `-P`:
   rows are per process+interface), parses its CSV (`time,process.pid,
   interface,state,bytes_in,bytes_out,...`), drops `lo0` and empty-name rows,
   strips the `.pid` suffix for storage but keeps raw name+pid columns, reads
   `sysctl -n kern.boottime` (the `sec =` field) each batch, stamps samples
   with the collector's own clock as UTC epochs. A failed or unparseable batch
   is skipped whole — no partial batch is ever written; log and continue.
2. **Write path** uses ticket 01's rules: store every series whose cumulative
   differs from the previous batch in either direction (a decreased sample MUST
   be stored); write a `discontinuity` row on boot change or decrease; refresh
   the rebuildable `usage_day` rollup after each batch.
3. **HTTP API** (`src/server.ts`, bin `net-server`): port resolved as
   `NET_SERVER_PORT`, then `PORT`, then default **8531** (ADR 0050 order; the
   number collides with nothing). Routes exactly:
   - `GET /api/summary` → `{ lastSampleAt, bootEpoch, coverage:
     {sampleCount, firstSampleAt}, period: {start, end} | null, totals:
     {bytesIn, bytesOut}, attributedBytes, unattributedBytes, agentShare:
     [{name, bytes}], config }` — totals computed at read time over en*
     interfaces per decision internet-spend-001; period bounds per decision 003;
     agent share labeled approximate by construction.
   - `GET /api/days?window=N` (default 30, clamped 1..366) → `{ days: [{
     date: 'YYYY-MM-DD', bytesIn, bytesOut, partial, known }], gaps: [{
     start, end, kind }] }` — one entry per local calendar day in the window;
     hole days carry `known: false`; gaps are hatch spans with kind
     `'boot' | 'decrease' | 'gap'`.
   - `GET /api/config` → `{ limitBytes: number|null, resetDay: number|null,
     agentPatterns: string[] }` with defaults `null, null,
     ["node","claude","Claude","codex","ox"]`.
   - `PUT /api/config` accepting any subset of those three fields;
     `limitBytes` must be a positive integer or null, `resetDay` an integer
     1..31 or null, `agentPatterns` an array of non-empty strings; invalid
     input → 400, nothing persisted.
   - CORS: GETs answer open; PUT echoes origin against `NET_ALLOWED_ORIGINS`
     (default `http://localhost:5173,http://127.0.0.1:5173`) mirroring the
     claude server's write-CORS shape. Zero changes to any existing server
     package.
4. **Zellij**: `.zellij/net-server.kdl` modeled on `.zellij/ox-alpha-proxy.kdl`
   (pin cwd per pane so a bare `pnpm --dir stacks/net server` resolves inside
   the new stack); `stacks/net/scripts/zellij.sh` resolving the repository top
   level like its siblings'; `.zellij/README.md` gains the fourth layout's
   section including the env vars it reads.
5. **Docs**: AGENTS.md gains the `net` row in the stack table (proxy column n/a
   — write "—" or the server port) plus one prose line noting the collector is
   in-process and a LaunchAgent is deliberately out of scope (decision
   internet-spend-005); CHANGELOG.md bullet prepended per house style.
6. **Tests** beside the package (vitest): nettop CSV parsing incl. quoted names
   and missing interface; boottime parsing; batch skip-on-error; route handlers
   over an injected fake db/clock (no real port binding needed for unit tests);
   config validation cases; CORS header behavior for GET vs PUT allow/deny.
7. `pnpm --filter @agent-proxy/net-server typecheck && pnpm --filter
   @agent-proxy/net-server test` green; `my-command-tools verify` green
   repo-wide.

## Verification

Start it once manually in the worktree (`pnpm --filter @agent-proxy/net-server
start` in background with a log), confirm one sample batch lands in the SQLite
file and `curl http://localhost:8531/api/summary` returns real nonzero byte
counts for this machine, then stop it. Paste nothing into the PR yet — live
evidence belongs to the campaign close — but state in the PR body that the
manual smoke ran.
