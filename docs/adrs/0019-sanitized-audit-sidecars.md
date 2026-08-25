---
type: adr
title: Keep audit sidecars sanitized
description: Persist strict, versioned, sanitized usage metadata; request and response bodies have no schema slot.
tags: [architecture, privacy, storage]
timestamp: 2026-08-19
scope: all
provenance:
  - repo: codex-proxy
    number: "0002"
    file: docs/adrs/0002-sanitized-bike-sidecars.md
  - repo: ox-alpha-proxy
    number: "0002"
    file: docs/adrs/0002-sanitized-sidecars.md
decided-by: /dev
ratified: false
needs-human: true
---

# Keep audit sidecars sanitized

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

Bike needs token and cost visibility. Bodies contain prompts, generated text, tool
definitions, and credentials that Bike does not need. The question in both repositories
was whether to persist full request and response bodies alongside the audit sidecars, or
to retain only sanitized usage metadata.

## Decision

**Persist sanitized audit sidecars only, and enforce it through the schema rather than
through discipline.** The proxy writes strict, versioned, sanitized JSON sidecars whose
schema accepts exactly its named fields: schema version, record identity, timestamp,
model, endpoint pathname, response status, request id, usage, cost, and cost
unavailability reason.

**Unknown fields fail validation.** Request bodies, response bodies, prompts, tool
definitions, tool calls, text output, credentials, cookies, arbitrary headers, and query
strings have no schema slot at all.

## Consequences

- The stack has a narrow privacy and storage boundary.
- Accidental schema expansion across that boundary fails validation rather than passing
  quietly, which is what makes the boundary hold over time.
- Final sidecars are the source of truth; SQLite is a rebuildable view.
- Body-dependent inspection belongs to Boat and requires explicit opt-in, redaction, and
  retention controls (see ADR 0021 for where Boat sits on the ladder).
- Proxy tests MUST prove that distinctive secret and body markers never enter an audit
  artifact.

## Provenance

**One decision, recorded separately by two repositories, restated here once.** Merged
from `codex-proxy` `docs/adrs/0002-sanitized-bike-sidecars.md` (`codex#0002`) and
`ox-alpha-proxy` `docs/adrs/0002-sanitized-sidecars.md` (`ox-alpha#0002`) during the
`monorepo-fusion` campaign, under ADR 0053. It carries codex's earlier `2026-08-19`
timestamp; ox-alpha-proxy restated the decision on `2026-08-22`, itself citing the codex
record as its source.

**Governs the `codex` and `ox-alpha` stacks.** The two records reach the same boundary by
different routes, and the merged statement above keeps both halves rather than choosing
one: codex-proxy states the prohibition and the test obligation, while ox-alpha-proxy
states the closed, versioned schema that makes the prohibition structural. Neither half
is dropped, because each is the reason the other holds.

**Ratification is preserved by union.** codex#0002 carried `needs-human: true` and
ox-alpha#0002 carried no flag; the merged record keeps the flag, because a merge may
never clear one (ADR 0052).

**This record replaces both originals rather than superseding them.** Both persist in
this repository's own git history, the form ADR 0029 blessed. See
[the legacy map](legacy-map.md) for why a merge is not a supersession.
