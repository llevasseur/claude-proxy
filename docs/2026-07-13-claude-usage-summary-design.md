---
type: design
title: Claude Usage Daily Summary — Design Spec
description: Device-wide Claude Code usage capture producing a once-daily end-of-day summary.
tags: [usage, daily-summary, design]
timestamp: 2026-07-13
---

# Claude Usage Daily Summary — Design Spec

**Date:** 2026-07-13
**Status:** Approved (brainstorming complete, pending implementation plan)
**Scope:** Device-wide Claude Code usage monitoring. Touches only
`~/Documents/ghub/personal/claude-proxy` and `~/Documents/ghub/personal/test-eve/my-agent` (both
under the personal profile). **Does not touch `hyperion-nexus-app`.**

## Goal

Passively capture every Claude Code request device-wide (including sessions launched from the
native `claude agents` dashboard) and produce a **once-daily, end-of-day summary** delivered as a
macOS notification plus an appended dated Markdown log. The summary covers four areas:

1. **Token burn & cost** — real input tokens (input + cache-read + cache-creation), output tokens,
   cache-hit ratio, estimated $ cost, and day-over-day delta.
2. **Context bloat culprits** — which tools / system-prompt sections eat the most context per
   request, ranked, with trim suggestions.
3. **Activity overview** — request count, busiest hour, models used + per-model counts.
4. **Agent-use coaching** — qualitative advice derived from the numbers (2–3 concrete suggestions).

The hard numbers are computed **deterministically** in code; the eve agent adds only the
qualitative coaching layer on top of a compact digest (Approach A). This keeps prompts tiny, makes
the arithmetic exact, and scales regardless of log volume.

## Enterprise-safety rationale

The user is on an enterprise Claude subscription and cannot/should not repoint or copy the
managed OAuth credential. `claude-proxy` is a **transparent pass-through**: it forwards the request
(auth header and all) untouched to `api.anthropic.com` and streams the reply straight back, storing
**nothing sensitive** — `authorization`, `x-api-key`, and `api-key` headers are written as
`[REDACTED]` in logs. No credential is copied into third-party storage. This is why the local proxy
is used instead of a rerouting gateway like CLIProxyAPI.

## Architecture

| # | Component | Status | Role |
|---|-----------|--------|------|
| 1 | `claude-proxy` on :8787 | existing + small change | Captures each request; adds a structured JSON sidecar |
| 2 | Device-wide env routing | new (config) | Routes all Claude Code sessions through the proxy |
| 3 | eve `my-agent` server on :3000 | existing | Runs the summarizing agent (`eve start`) |
| 4 | `scripts/lib/usage-digest.ts` | new — pure module | Reads a day's audit sidecars → structured digest object |
| 5 | `scripts/usage-summary.ts` | new — daily entry | Digest → prompt agent → notify + write summary → archive + prune |
| 6 | 3 launchd agents | new (config) | Keep proxy + eve up; fire the daily summary |

### Component 1 — proxy sidecar (small change to `proxy.mjs`)

`proxy.mjs` already computes an `audit` object per request (real input tokens, tool count, per-tool
bytes/tokens, system-prompt bytes). Add ~3 lines so that alongside each existing
`<ts>_anthropic.md` it also writes `<ts>_anthropic.audit.json` containing that audit object plus:

- `model` (from the request/response)
- `timestamp` (ISO, from the filename base)
- `outputTokens` (from response usage, if present)
- `statusCode`

The `.md` files are unchanged (still human-readable). The digest parser reads only the JSON
sidecars — robust, no Markdown regex. Only requests made after this change get sidecars; summaries
begin from that point forward.

### Component 2 — device-wide routing

`claude agents` opens the native Claude Code Agents dashboard; the sessions it spawns are children
of the Claude Code CLI. The clean device-wide hook is the existing `env` block in
`~/.claude/settings.json`:

```json
"env": {
  "CLAUDE_CODE_NO_FLICKER": "1",
  "ANTHROPIC_BASE_URL": "http://localhost:8787"
}
```

This routes **every** session — including all agents-page sessions — through the proxy with no
per-launch wrapper.

**Consequence (load-bearing proxy):** with this set, if the proxy is down, every Claude Code
session fails with connection-refused. Mitigated by running the proxy under launchd `KeepAlive`
(Component 6). Escape hatch: launch a one-off session with `ANTHROPIC_BASE_URL= claude`, or remove
the settings line.

### Component 4 — `usage-digest.ts` (pure, unit-testable)

Input: a target date + the proxy `logs/` directory. Globs `*_anthropic.audit.json` whose filename
date matches the target day. Returns a `UsageDigest` object:

```
UsageDigest {
  date: string
  requestCount: number
  models: Record<model, count>
  tokens: { input, cacheRead, cacheCreation, output, cacheHitRatio }
  cost: { input, output, cacheWrite, cacheRead, total }   // estimated
  topTools: Array<{ name, totalBytes, estTokens, pctOfToolBytes }>  // top N by bytes
  avgSystemPromptBytes: number
  toolOverheadPctOfInput: number
  busiestHour: { hour: number, requestCount: number }
  trend?: { field: string, today: number, yesterday: number, deltaPct: number }[]  // vs stored prior digest
}
```

- **Cost** is estimated via an editable per-model price map (`$/MTok` for
  input / output / cache-write / cache-read). Explicitly approximate.
- **Trend** compares against yesterday's digest stored at
  `~/.claude-usage/digests/YYYY-MM-DD.json`. Absent on first run.
- **Sessions** are intentionally omitted — the logs carry no reliable session ID. Activity uses
  request counts + hourly buckets instead.

### Component 5 — `usage-summary.ts` (daily entry point)

Ordered steps, mirroring the existing `commit-summary.ts` pattern:

1. Compute today's `UsageDigest` via `usage-digest.ts`.
2. If zero requests: write a one-line "no Claude activity today" summary, notify, **skip** archive.
   Exit 0.
3. Format the digest as a compact text block; call `askAgent(prompt + digest)` against eve
   (`EVE_BASE_URL=http://localhost:3000`, overriding the lib's :2000 default).
4. `notify()` macOS banner + append a dated section to `~/claude-usage-summaries.md`.
5. Persist today's digest JSON to `~/.claude-usage/digests/YYYY-MM-DD.json` (for tomorrow's trend).
6. Archive today's raw logs (`.md`, `.request.txt`, `.audit.json`) to
   `logs/archive/YYYY-MM-DD/`.
7. Prune archive directories older than `RETENTION_DAYS` (default **30**, editable).

Errors follow the existing pattern: try/catch, `notify("… — error", msg)`, non-zero exit.

### Component 6 — launchd (all three via launchd)

| launchd agent | Trigger | Purpose |
|---|---|---|
| `com.leevon.claude-proxy` | `RunAtLoad` + `KeepAlive` | Always-up capture (`node proxy.mjs`) |
| `com.leevon.eve-my-agent` | `RunAtLoad` + `KeepAlive` | Always-up summarizer backend (`eve start`, :3000) |
| `com.leevon.claude-usage-summary` | `StartCalendarInterval` ~17:30 weekdays | Fires `usage-summary.ts` |

launchd chosen over cron: survives reboot, consistent with the KeepAlive agents.

## Data flow

**Continuous:** `claude agents` session → proxy :8787 → `api.anthropic.com` (reply streamed back).
Proxy writes `<ts>_anthropic.md` + `.request.txt` + new `.audit.json`.

**Daily EOD (launchd):** `usage-summary.ts` → `usage-digest.ts` (today's audit sidecars) → digest
→ `askAgent` (eve :3000) → summary text → notify + append `~/claude-usage-summaries.md` → persist
digest JSON → archive raw logs → prune old archives.

## Error handling

- **No logs today** → friendly one-line summary, no archive, exit 0.
- **eve server down** → `askAgent` throws a clear "is the eve server running?" error → notify +
  exit 1. (KeepAlive should prevent this.)
- **Proxy down** → Claude Code sessions fail fast (connection-refused). KeepAlive mitigates;
  documented escape hatch to unset `ANTHROPIC_BASE_URL`.
- **Malformed / partial sidecar** → digest skips that file and counts it in a `skipped` tally
  surfaced in the summary; never aborts the whole run.

## Testing

- `usage-digest.ts` is a **pure function** → unit-tested with a fixture `logs/` dir containing
  sample `.audit.json` files (empty day, single request, multi-model, malformed sidecar, trend vs a
  seeded prior digest). This is the only logic that needs automated tests.
- `usage-summary.ts`, `notify`, launchd, and the proxy sidecar write are I/O side-effects →
  verified manually (run once end-to-end, confirm notification + file contents + archive move).
- Enterprise end-to-end check right after setup: launch a real `claude agents` session, confirm it
  works through the proxy and a sidecar is written. If the company ever routes through a
  gateway/Bedrock/Vertex, remove the settings line (proxy targets `api.anthropic.com`).

## Success criteria

1. A `claude agents`-launched session routes through the proxy and produces a `.audit.json` sidecar.
2. The daily job fires unattended and delivers a notification + appended dated summary covering all
   four insight areas, with exact token/cost numbers and a day-over-day trend (from day 2).
3. `logs/` stays bounded: each day's raw logs archived, archives older than 30 days pruned.
4. Proxy and eve survive logout/login and crash (launchd KeepAlive).
5. No credentials are ever written to disk; nothing touches `hyperion-nexus-app`.

## Out of scope (YAGNI)

- Interactive "how's my token burn this week?" queries (the extractable `usage-digest.ts` module
  makes wrapping it as an eve tool trivial later — deferred).
- Session-level attribution (no session ID in logs).
- Weekly rollups, dashboards, remote/off-device delivery.

## File / location summary

- `~/Documents/ghub/personal/claude-proxy/proxy.mjs` — add audit-JSON sidecar write.
- `~/Documents/ghub/personal/claude-proxy/docs/2026-07-13-claude-usage-summary-design.md` — this spec.
- `~/Documents/ghub/personal/test-eve/my-agent/scripts/lib/usage-digest.ts` — new pure module.
- `~/Documents/ghub/personal/test-eve/my-agent/scripts/usage-summary.ts` — new daily entry.
- `~/.claude/settings.json` — add `ANTHROPIC_BASE_URL` to existing `env` block.
- `~/Library/LaunchAgents/com.leevon.{claude-proxy,eve-my-agent,claude-usage-summary}.plist` — new.
- `~/claude-usage-summaries.md` — output log (created on first run).
- `~/.claude-usage/digests/YYYY-MM-DD.json` — persisted digests for trend (created on first run).
