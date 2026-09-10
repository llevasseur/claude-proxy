---
type: adr
title: One delta rule, typed discontinuities, gap and quiet split
description: The shared write/read delta rule for cumulative counter series, how decreases, reboots, long gaps and known-quiet spans classify, and how a day's label aggregates.
tags: [net, deltas, discontinuities, aggregates]
timestamp: 2026-08-25
scope: net
decided-by: /dev
ratified: false
wayfinder: internet-spend
grill-round: 2
needs-human: false
---

# One delta rule, typed discontinuities, gap and quiet split

> **Status: proposed — NOT ratified by a human.** Proposed by the `/dev`
> workflow running unattended. It is the scoped hole-semantics requirement
> ("never interpolate, estimate, or fabricate; show a hole") carried into cases
> the scope did not name.

## Context

The griller's questions, verbatim in part:

> Question 2 of ~8 — when a counter goes down without a reboot, what is the delta? … pids get reused … At read time, consecutive samples of that key produce a **negative delta** … does the write-time nonzero-delta filter use the *same* rule, so that a stored corpus and a recomputed one always agree?

> Question 4 of ~9 — when one delta spans three days, whose days do those bytes belong to? … Thursday shows a 3× spike that never happened; Monday–Wednesday render as **zero**, not as hatched unknowns …

> Question 8 of ~9 — does every overnight sleep become a hatched hole? … every single morning hatches a band across yesterday and today …

> Question 9 of ~9 — when thousands of series disagree about a day, who wins the hatch? … what is the exact precedence order … does "known-quiet" require universal series agreement or majority evidence, and is the sub-cadence-process blind spot explicitly documented on the page …?

## Decision

One delta rule, keyed on `(name, pid, interface)` series within equal
`boot_epoch`, used identically by writer and reader:

1. A series' first sample establishes the baseline only — no bytes, no verdict.
2. Consecutive samples with `new >= old`: delta = `new - old`.
3. Consecutive samples with `new < old` (pid reuse, counter reset): the
   interval's bytes are UNKNOWN — zero counted bytes, recorded as a typed
   decrease discontinuity, hatched, intersecting days marked partial.
4. `boot_epoch` change takes precedence as its own discontinuity type.
5. The write-time filter stores any sample whose summed cumulative differs from
   the previous batch **in either direction** — a decreased sample must be
   stored or the discontinuity becomes invisible at read time. Write-time and
   read-time therefore agree by construction.

Gap classification (span > 3× the sampling cadence; cadence is 1h):

6. Sub-threshold interval: attributed to its END timestamp's local day.
7. Gap interval with ZERO delta: the counters prove no wire traffic crossed any
   tracked interface across the span — a KNOWN-QUIET interval. Renders flat,
   no hatch, no partial flag. An overnight-sleeping Mac produces these nightly
   and is rendered truthfully quiet, not holed.
8. Gap interval with NONZERO delta: intra-interval distribution genuinely
   unknowable — the true hole case. Bytes count fully toward period totals,
   contribute nothing to daily bars, hatch across `[start, end)`, and every
   local day intersecting the span is marked partial.

Day-label aggregation:

9. Precedence, highest first, all existential (any single series flips the
   day): boot-change discontinuity > decrease discontinuity > nonzero gap.
10. Absent those, the day is simply ATTRIBUTED — there is no "known-quiet"
    verdict requiring universal series agreement; quiet is an attributed day
    whose summed bytes are zero.
11. Invariant: totals + sum(daily attributed) + sum(unattributed gap bytes)
    equals the sum of all valid deltas. Nothing is interpolated or split.
12. Accepted-and-labeled limitation: processes whose entire life fits between
    two hourly samples are measured by nothing. The /internet page carries this
    in its footnote beside the approximate agent-share label.
