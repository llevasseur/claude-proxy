---
type: feature
title: Bike — live sanitized usage overview
description: The smallest complete ox-alpha-proxy outcome — transparent forwarding and live token and cost visibility.
tags: [bike, proxy, usage, privacy]
timestamp: 2026-08-22
---

# Bike — live sanitized usage overview

Provenance: adapted from `codex-proxy` `docs/features/bike.md`.

Bike reaches the destination with one safe loop: client traffic still reaches its configured OpenAI upstream, and
the operator can see today's input tokens, output tokens, and estimated cost on one live Overview page.

## Product promise

- The proxy preserves the request method, path, query, headers, body bytes, response status, headers, and streamed
  response bytes. Unknown endpoints and unrecognized payloads still pass through.
- Metric parsing is optional to forwarding. A parsing, pricing, or sidecar failure cannot change bytes already sent
  to the client.
- Bike persists sanitized identifiers and usage metrics only. It never persists request or response bodies, prompts,
  tool definitions, tool calls, text output, credentials, cookies, or arbitrary headers.
- Input and output tokens remain visible when cost is unavailable. Unknown models or missing consumed-category rates
  make the whole estimate unavailable; Bike never substitutes zero or labels a partial estimate as total cost.
- One Overview page shows Today in the configured report timezone and updates through SSE without a reload.

These boundaries are owned by [ADR 0001](../adrs/0001-use-responses-contract.md),
[ADR 0002](../adrs/0002-sanitized-sidecars.md), [ADR 0003](../adrs/0003-unavailable-incomplete-cost.md), and
[ADR 0007](../adrs/0007-transparent-http-surface.md).

## Run shape

The proxy, server, and dashboard run as separate processes. The proxy writes immutable, versioned, sanitized JSON
sidecars and a body-free status signal. The server validates final sidecars, maintains an idempotent SQLite view,
and serves health, Today summary, and live SSE endpoints. The browser talks only to the local server.

Configuration comes from environment variables documented in `.env.example`: upstream URL, local bind addresses,
audit directory, database path, and `REPORT_TZ`. `REPORT_TZ` defaults to `America/New_York` at the server boundary;
pure core functions accept the timezone and clock explicitly.

## Data lifecycle and recovery

Final audit sidecars are the source of truth. Temporary files from interrupted atomic writes are ignored. SQLite is
a disposable materialized view, so recovery removes the database and re-ingests every final sidecar. Idempotent
record IDs prevent restarts, watcher duplicates, and reconciliation scans from double-counting usage.

Body capture is not a hidden Bike option. It begins only in Boat with explicit opt-in, redaction, and retention
controls (see [Boat](boat.md)); Car must remain useful without it, and stays useful with zero inspection data present.

## Publication boundary

This project starts with fresh history and ships through a private repository, as recorded by
[ADR 0005](../adrs/0005-fresh-repository-history.md) and [ADR 0006](../adrs/0006-private-github-publication.md).
