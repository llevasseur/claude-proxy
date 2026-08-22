---
type: adr
title: Promise transparent HTTP forwarding
description: Forward the complete HTTP surface and extract metrics only from recognized Responses traffic.
tags: [architecture, proxy, compatibility]
timestamp: 2026-08-22
decided-by: /dev
ratified: false
wayfinder: ox-alpha-proxy
grill-round: 2
---

# Promise transparent HTTP forwarding

## Status

Proposed by `/dev`. A human has not ratified this decision.

## Provenance

Adapted from `codex-proxy` `docs/adrs/0007-transparent-http-surface.md`.

## Decision

Forward every method, path, query, header, body, response status, and streaming
byte to and from the configured upstream. Extract usage only where the
Responses protocol is understood. Pass unknown traffic through unchanged.

## Consequences

- Compatibility tests compare proxied traffic with direct upstream fixtures.
- Metric parsing is optional and cannot control forwarding success.
- New endpoints work before the project learns how to measure them.
