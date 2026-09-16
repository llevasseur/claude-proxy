---
type: adr
title: warm.json ships without a dashboard card
description: The status file is written in usage-live.json's shape so the admin dashboard can render it later, but no admin route or card is built in this campaign.
tags: [proxy, cache, admin, scope]
timestamp: 2026-09-15
scope: claude
decided-by: /dev
ratified: false
wayfinder: warm-cache
needs-human: true
---

# warm.json ships without a dashboard card

## Status

Proposed by `/dev` running unattended. A human has not ratified this decision. It is a
scope call made on the user's behalf.

## Context

The brief asked that warm status be mirrored to `logs/warm.json` "in the same shape and
spirit as the existing `logs/usage-live.json`, **so the admin dashboard can render it**."

That final clause reads two ways: as the motivation for the file's shape, or as a request
for an admin page. The campaign had to pick one, and nobody was available to ask.

## Decision

**Write `logs/warm.json`; build no admin route, card, or API endpoint for it in this
campaign.**

The clause is read as motivation. Three reasons:

1. The brief's numbered deliverables are explicit — the module, the control endpoint, the
   `/warm` command, the stop conditions, the two must-nots, and the tests. **No admin work
   is among them.** A dashboard card would be scope this run added on its own reading of a
   subordinate clause.
2. The file is what makes a card *possible later* without touching the proxy again, which
   is exactly what "so the dashboard can render it" asks for. Shipping the file discharges
   the clause.
3. A page in `stacks/claude/admin/src/routes/` is a new registry entry, a station in the
   rail, and a server route — a meaningful surface, and one
   [ADR 0042](0042-claude-dashboard-is-the-design-baseline.md) says UI design is delegated
   for rather than improvised.

The file's shape follows `usage-live.json`: an atomic write through a `.tmp` file and a
rename, into `LOG_DIR`, which also wakes the server's existing log-directory SSE watcher.
It carries status only — entries, their state, ping counts, `usageUnits` spent, and stop
reasons — and never a body, prompt, or credential.

## Consequences

- Warm status is readable today with `cat logs/warm.json`, and by the server whenever
  someone adds a reader.
- **A human who wanted a card did not get one.** That is the risk this record exists to
  surface; adding the card later needs no proxy change.
- `warm.json` is the ledger [0077](0077-a-ping-never-enters-handle.md) relies on and the
  instrument [0078](0078-resume-rate-is-below-break-even.md) needs to settle the resume
  rate, so it earns its place independently of any UI.
