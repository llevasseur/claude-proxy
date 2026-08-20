---
type: plan
title: Bike release 02 — Transparent OpenAI/Codex proxy
description: Forward Codex traffic byte-for-byte while atomically recording sanitized usage sidecars.
tags: [planning, proxy, responses-api]
timestamp: 2026-08-19
wayfinder: bike-release
task: 02
status: todo
---

# Bike release 02 — Transparent OpenAI/Codex proxy

## Outcome

Ship a zero-runtime-dependency Node proxy that can sit transparently between
Codex and a configured OpenAI-compatible upstream. Forward all traffic without
changing application behavior and atomically record only sanitized Bike usage
metadata for Responses traffic the proxy understands.

## Dependencies

Task 01. This ticket may run in parallel with task 03 after task 01 lands.

## Owned paths

This ticket alone owns proxy implementation and tests under `proxy/src/**`,
`proxy/test/**`, and proxy-specific examples under `proxy/examples/**`. It may
update `proxy/README.md`. It MUST NOT edit workspace manifests, the lockfile,
core, server, app, or durable cross-project docs.

## Requirements

- Run directly on Node 22+ from TypeScript source with zero runtime dependencies,
  no compilation step, and no `dist/` directory.
- Listen on a configurable local address and forward to a configurable OpenAI
  upstream. Preserve every HTTP method, path, query, request header, request
  body byte, response status, response header, and response stream byte. Support
  non-streaming, SSE streaming, arbitrary endpoints, and error responses.
- Do not buffer a request or response before forwarding it. Backpressure,
  disconnects, aborts, upstream errors, and streaming chunk boundaries must not
  corrupt or delay the client-visible exchange.
- Treat the forwarding path as generic. Parse metrics only when a body is a
  recognized Responses API request/response or Responses SSE sequence. Unknown
  endpoints, future event types, malformed usage, and unrecognized models pass
  through unchanged and do not crash the proxy.
- Extract the final authoritative usage once from a recognized response. Use the
  shared core normalizer and pricing catalogue; do not duplicate token or cost
  calculations in the proxy.
- Write one schema-valid sanitized audit sidecar after the response completes.
  The file contains only the allowed identifiers and usage fields from the core
  schema. It MUST NOT contain request bodies, response bodies, prompts, tool
  definitions, tool arguments/results, response text, authorization values,
  cookies, or arbitrary headers.
- Make the sidecar durable with a same-directory temporary file, flushed/closed
  contents, and atomic rename to its final immutable name. A crash before rename
  may leave an ignorable temporary file but never a truncated final sidecar.
- Keep proxy and server failure domains separate. The proxy only writes files;
  it never opens SQLite or calls the local server. Sidecar or metric failures are
  reported safely and never mutate already-forwarded traffic.
- Expose process-level live readiness in a small machine-readable status file or
  equivalent filesystem signal that the server can observe without coupling the
  proxy to the server. Define startup, ready, upstream-error, and shutdown
  transitions without storing secrets.

## Acceptance criteria

- Contract tests compare client-visible requests and responses through the proxy
  with direct upstream fixtures across GET/POST, path/query variants,
  non-Responses endpoints, JSON Responses, SSE Responses, upstream 4xx/5xx,
  abrupt disconnects, and binary/unknown bodies.
- Streaming tests prove the first upstream byte is forwarded before completion
  and prove response bytes/status/headers are unchanged.
- Recognized Responses fixtures produce correct input/output token and cost data.
  Unknown price data produces `cost: null` with an availability reason.
- Sanitization tests seed secrets and distinctive body/header text, then prove
  none appears anywhere in the final sidecar or temporary artifacts.
- Atomicity tests simulate interrupted writes and prove the server can ignore
  temporary files and never reads partial final JSON.
- Proxy package inspection confirms zero runtime dependencies and execution from
  source on Node 22+.

## Verification

- Run the proxy's unit and integration tests, including real local streaming
  fixtures and disconnect cases.
- Run the root typecheck, test, check, and aggregate verifier.
- Start a fixture upstream and the proxy, send both streaming and non-streaming
  requests, compare captured client bytes, then validate the emitted sidecars
  against the core schema.
- Search sidecar fixtures and runtime output for seeded authorization, prompt,
  response, and tool payload markers; the search must return no matches.
