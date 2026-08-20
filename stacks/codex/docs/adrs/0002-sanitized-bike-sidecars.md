---
type: adr
title: Keep Bike audit sidecars sanitized
description: Persist usage metadata in Bike without retaining request or response bodies.
tags: [architecture, privacy, storage]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 3
needs-human: true
---

# Keep Bike audit sidecars sanitized

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “Should Bike persist full request and response bodies alongside audit sidecars, or retain only sanitized usage metadata?”

Bike needs token and cost visibility. Bodies contain prompts, generated text,
tools, and credentials that Bike does not need.

## Decision

Persist sanitized audit sidecars only. Do not persist request bodies, response
bodies, prompt content, tool definitions, tool calls, arbitrary headers, or
credentials in Bike.

## Consequences

- Bike has a narrow privacy and storage boundary.
- Body-dependent inspection belongs to Boat and requires explicit opt-in,
  redaction, and retention controls.
- Proxy tests MUST prove distinctive secret and body markers never enter an
  audit artifact.
