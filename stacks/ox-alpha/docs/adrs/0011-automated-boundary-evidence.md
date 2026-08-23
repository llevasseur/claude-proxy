---
type: adr
title: Certify phase boundaries with automated evidence
description: Fixture, integration, and SSE tests plus the verify gates certify a phase; live upstream validation stays with the human.
tags: [process, verification]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 10
needs-human: true
---

# Certify phase boundaries with automated evidence

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> "At each phase-boundary blocking edge, what is the accepted standard of proof — automated fixture/integration/SSE-test evidence plus the five verify gates alone, or must each phase additionally demonstrate live end-to-end forwarding through a real upstream?"

The run holds no upstream credentials and no driver of real client traffic.

## Decision

Automated evidence certifies every phase boundary: the five-gate `pnpm verify`
chain plus fixture-based integration and SSE-stream tests covering each phase's
stated verification list. Live end-to-end validation through a real upstream is
recorded as outstanding at each boundary merge and listed in the closing pull
request as the first item for human post-review.

## Consequences

- The campaign never blocks waiting for credentials or traffic.
- A wire-level surprise found during live validation invalidates forward work;
  the four-rung ladder bounds that blast radius.
