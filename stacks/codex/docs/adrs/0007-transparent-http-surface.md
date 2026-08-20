---
type: adr
title: Promise transparent HTTP forwarding
description: Forward the complete HTTP surface and extract metrics only from recognized Responses traffic.
tags: [architecture, proxy, compatibility]
timestamp: 2026-08-19
decided-by: /dev
ratified: false
wayfinder: bike-release
grill-round: 11
needs-human: true
---

# Promise transparent HTTP forwarding

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Context

> “What HTTP surface does Bike promise: only the Responses endpoint needed by current Codex, or transparent forwarding of every method, path, query, header, status, and streaming byte to the configured OpenAI upstream while extracting usage only where the Responses protocol is understood?”

Restricting forwarding to today's observed endpoint would make the proxy itself
a compatibility gate for future Codex or OpenAI traffic.

## Decision

Forward every method, path, query, header, body, response status, and streaming
byte to and from the configured OpenAI upstream. Extract usage only where the
Responses protocol is understood. Pass unknown traffic through unchanged.

## Consequences

- Compatibility tests compare proxied traffic with direct upstream fixtures.
- Metric parsing is optional and cannot control forwarding success.
- New endpoints work before the project learns how to measure them.
