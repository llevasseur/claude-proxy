---
type: adr
title: Republish the corpus adapted, not copied
description: Inherit decisions through adapted republication with provenance citations, never verbatim copies.
tags: [docs, process, corpus]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 7
needs-human: true
---

# Republish the corpus adapted, not copied

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "How does the decision corpus physically land in ox-alpha-proxy — verbatim historical import plus superseding records, in-place adaptation with renumbered ADRs, or a hybrid?"

An imported corpus would contradict itself on day one (codex-proxy's five-rung
ladder against this repository's four-rung ladder).

## Decision

Adapted re-publication. Every inherited decision is restated in this
repository's voice under its own numbering starting at 0001, each carrying a
Provenance section citing the exact codex-proxy document it came from. No
codex-proxy file is copied verbatim. `REPORT_TZ` keeps its `America/New_York`
default unchanged.

## Consequences

- The corpus is internally consistent from birth.
- codex-proxy's documents remain the historical record where they live.
- Renumbering breaks numeric correspondence with codex-proxy ADR numbers;
  provenance sections are the mapping.
