---
type: adr
title: Keep operator credentials out of the browser
description: Route dashboard Notes access through the local server so operator credentials remain at the machine trust boundary.
tags: [architecture, notes, security, dashboard]
timestamp: 2026-08-16
scope: claude
provenance:
  - repo: claude-proxy
    number: "0012"
    file: docs/adrs/0012-keep-operator-credentials-out-of-the-browser.md
decided-by: /dev
ratified: false
wayfinder: notes
grill-round: 6
needs-human: true
---

# Keep operator credentials out of the browser

## Status

Proposed by `/dev`. This decision has not been ratified by a human.

## Context

> the dashboard is local and ADRs 0005/0006 place the operator token at the machine trust boundary: must the browser call only the local Node server, which proxies Notes requests using server-side operator credentials, so the shared write token is never exposed to client JavaScript?

The operator token grants writes across hosted datasets. Shipping it to browser JavaScript would broaden its exposure beyond the existing machine-side boundary.

## Decision

Route browser Notes requests through the local Node server. Keep the operator token server-side and require trusted origin checks on local write routes.

## Consequences

The local server becomes a required proxy with no local Notes fallback. Browser code never receives the shared write token.

## Provenance

Native to `claude-proxy`, this repository's own corpus. It kept its number through the
`monorepo-fusion` merge because the claude block sorts first by timestamp and its numbering
was already dense. See [the legacy map](legacy-map.md) for how every inherited identifier
resolves.
