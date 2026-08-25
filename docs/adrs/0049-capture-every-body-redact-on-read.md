---
type: adr
title: Capture every body, redact on read and export
description: Bodies are captured unconditionally because the corpus is the product; redaction moves from capture time to every path that leaves the machine.
tags: [monorepo, privacy, storage, capture, campaign]
timestamp: 2026-08-23
scope: all
provenance:
  - campaign: monorepo-fusion
    decided: before the campaign began, by the repository owner
    recorded-by: monorepo-fusion ticket 13
decided-by: user
ratified: true
wayfinder: monorepo-fusion
needs-human: false
---

# Capture every body, redact on read and export

## Status

Accepted. Decided by the repository owner before the `monorepo-fusion` campaign began.

Revises the capture side of [0019](0019-sanitized-audit-sidecars.md), which gave request and
response bodies no schema slot at all. The redaction 0019 was protecting is kept in full and
moved, not dropped.

## Context

0019 enforced sanitization through the schema: sidecars accept exactly their named fields,
and bodies have nowhere to go. That is a strong guarantee and it was the right one for a
tool whose job was token and cost visibility.

It stopped being the right one when the corpus became the product. Skim, suggestions, the
context views and the judge **all read bodies**. Without bodies they do not degrade —
they do not exist.

The obvious middle position is an opt-in: capture bodies when the operator asks. It fails on
a property specific to this data. **A body not captured cannot be backfilled** — the traffic
happened, the response streamed, and there is no source to go back to. So an opt-in default
does not produce "less data"; it produces a **half-empty history** with permanent holes at
exactly the days the operator had not yet decided to turn it on, and those are the days a
retrospective question is most likely to reach for.

## Decision

**Capture every body, unconditionally.** No opt-in, no sampling, no per-endpoint allowlist.
The corpus is the product, and a complete corpus is the thing being built.

**Redact on read and export, rather than at capture.** Redaction is not dropped — it moves,
and it moves to a strictly larger set of paths: **every path that leaves the machine.** The
API surface, the export, the daily summary, anything shipped to a hosted store, anything
rendered into a shared artifact. What is captured to local disk is complete; what leaves is
redacted.

The justification for capturing in the clear locally is what claude-proxy is: **a local-only
observer of the user's own machine, recording the user's own traffic**. The bodies are
already on that machine, in that user's own session. Capturing them to that same machine
crosses no boundary that was not already crossed.

## Consequences

- Redaction becomes a property of every egress path, and each new one must be covered.
  This is a larger and more error-prone surface than a single capture-time filter, and that
  is the real cost of this decision: capture-time redaction fails closed, read-time
  redaction fails open, and a missed egress path leaks. Every path out is tested for it.
- 0019's schema-level guarantee is gone. Sidecars now have a body slot, so "the schema
  makes it impossible" is no longer available as an argument and is replaced by explicit
  redaction with explicit tests.
- **Bodies still age out under [0048](0048-deletion-policy-split-by-tier.md).** Capturing
  everything is not keeping everything forever — the age and byte cap still bind, and
  eviction still runs through the `blob_evicted` tombstone.
- Local disk usage rises to the full body corpus, bounded by 0048's cap.
- Anything derived from bodies is derived before eviction and is therefore forward-only —
  the constraint [0047](0047-sqlite-substrate-with-forward-only-migrations.md) rests on.

## Provenance

Decided by the repository owner before the `monorepo-fusion` campaign started, and
recorded here by that campaign's ticket 13.
