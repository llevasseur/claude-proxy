---
type: adr
title: The filter gate covers invocations, not records
description: A record quoting a broken command is evidence; a bulk rename that rewrites it destroys the measurement it was keeping.
tags: [monorepo, tooling, verification, docs]
timestamp: 2026-08-23
scope: all
decided-by: /dev
ratified: false
wayfinder: monorepo-fusion
grill-round: 0
needs-human: false
---

# The filter gate covers invocations, not records

## Status

Proposed by `/dev` during the `monorepo-fusion` campaign, after ticket 04. A human has
not ratified it. Not flagged `needs-human`: it narrows a gate this campaign introduced,
against evidence the campaign itself produced.

## Context

ADR 0055 added a `verify` gate refusing any `--filter` argument that names an unscoped
package, because pnpm answers a filter matching nothing with a warning and exit 0. Ticket
03 landed it red at 152 findings; ticket 04 cleared it to **13**.

Those 13 did not survive because anyone missed them. Every one lives in the campaign's
own scaffolding — plans `02`, `03` and `04`, and the campaign map — and every one quotes
an unscoped filter **as the defect being described**. A plan cannot state the problem
without spelling it. The ticket-04 runner correctly refused both to edit other tickets'
plans and to weaken the gate, and handed the conflict back.

**The same bulk pass had already demonstrated the cost of the alternative.** It rewrote
five sentences in ADR 0055 itself, converting recorded measurements into claims about the
post-rename world:

- "**104** occurrences of `--filter @agent-proxy/claude-server`" — false, and the
  falsehood erases the finding. Those 104 were the **unscoped** name; that it appeared
  104 times *is* the measurement.
- "`--filter @agent-proxy/claude-server` names one package today and one of three after
  fusion" — incoherent, since the scoped name names exactly one. The sentence only means
  anything about the unscoped name.
- Three more, including the plist invocation the ADR cites as the broken one.

Neither the gate nor `/review` could see any of it, because each rewrite made the text
*more* conformant. The gate cannot distinguish a citation from an invocation, so pointing
it at records does not protect them — it corrupts them, silently, in the direction the
gate rewards.

## Decision

**The gate covers executable surfaces. It does not cover records of what was measured.**

- **In scope:** source, scripts, `package.json`, workflows, `.plist` files, and
  `AGENTS.md`. These are read by a machine, or are instruction to a future agent. A stale
  filter in any of them fails open, which is the whole reason ADR 0055 exists.
- **Out of scope:** `docs/adrs/` and `docs/wayfinder/`. An ADR records what was true when
  it was written, and a plan records what was asked. In both, a broken command spelled out
  verbatim is **correct text** — it is the evidence, not a defect.

This is the same principle ADR 0052 already applied to inherited ratification flags: a
record's historical content survives a merge rather than being normalised into agreement
with the present. Here the normalising force is a grep instead of a bookkeeping
instruction, and the damage is the same shape.

`AGENTS.md` is deliberately on the executable side despite being prose. ADR 0055 argues
that case: it is not documentation here but the instruction every future agent reads, so
a stale invocation in it re-arms a failure the repository already paid for.

## Consequences

- The gate goes green on the current tree without any citation being edited, which
  unblocks landing CI (residual risk 7).
- `docs/wayfinder/` is deleted wholesale by the campaign's `zz` ticket, so excluding it
  costs nothing beyond the campaign's life.
- **A real stale invocation inside an ADR or a plan will not be caught.** Accepted: those
  files are read by people, not executed, and the failure ADR 0055 guards against is a
  machine silently doing nothing. A human reading a wrong command in a historical record
  is a different and much smaller problem than a scheduled job that no-ops.
- The five regressed sentences in ADR 0055 are restored to quote the pre-rename name.
  Anyone re-running a bulk rename over `docs/` should expect to reintroduce them, which is
  the second reason the exclusion is written down rather than left as a gate setting.

## Provenance

Decided in this repository during `monorepo-fusion`, from ticket 04's residual findings
and from the ADR 0055 regression the same ticket disclosed. Extends ADR 0055, which
introduced the gate, and shares its principle with ADR 0052.
