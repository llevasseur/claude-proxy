---
type: decision
title: "Decision internet-spend 003 — Short months clamp to the last day; UTC stored, local resolution"
description: Budget period boundaries under an anchored day-of-month reset, and the storage/resolution time split.
label: wayfinder:decision
map: map-internet-spend
status: proposed
timestamp: 2026-08-25
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 3
needs-human: false
---

# Decision internet-spend 003 — Short months clamp to the last day; UTC stored, local resolution

> **Status: proposed — NOT ratified by a human.** Proposed by the `/dev`
> workflow running unattended.

## Context

The griller's question, verbatim in part:

> Question 3 of ~8 — what is the current budget period when this month has no resetDay? … With `resetDay = 31`, February has no 31st … Clamp to last day of month … Anchor stays fixed, short month folds into the previous period (Jan 31 → Mar 1) … Skip (undefined) … Which clamp/fold rule do you choose, and why?

## Decision

1. **Clamp to the last day of the month.** With `resetDay = N`, a period starts
   on the Nth where that day exists, otherwise on the month's last day (Feb 31
   → Feb 28/29). Every period is exactly one calendar month long, which is what
   a byte budget means. The fold rule would create ~60-day periods during which
   the meter reads half-consumed against monthly intent; skip would fabricate a
   zero, violating the no-fabrication constraint. The anchor drifts earlier
   across short months and snaps forward on the next long month — standard
   billing-anchor behavior.
2. **Unset limit/resetDay falls back to calendar month-to-date** anchored on
   the 1st in local time.
3. **UTC epochs are the only durable truth; all day and period bucketing
   happens at read time in local time**, adopting ADR 0030
   (`docs/adrs/0030-calendar-date-range-api.md`). A timezone change re-buckets
   history rather than splitting stored aggregates.
4. `usage_day` is a rebuildable rollup: it inherits whatever bucketing is
   current and is rebuilt from raw rows rather than trusted.
