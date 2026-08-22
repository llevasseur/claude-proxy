# Task 03 — Transparent proxy with sidecar writer

## Goal

Build `@ox-alpha-proxy/proxy`: transparent HTTP/SSE forwarding plus observation
taps that write sanitized sidecars. Blocked by task 02.

## Criteria

1. Forwards every method, path, query, header, body byte, response status, header, and streamed response byte to and from the configured upstream (ADR 0007); unknown traffic passes through unchanged.
2. Zero runtime dependencies; runs from TypeScript source on Node 22+ via `node src/proxy.ts`; reads config only from process env (`OPENAI_UPSTREAM`, bind address, audit directory).
3. Observation taps recognized OpenAI Responses JSON or final Responses SSE usage without gating forwarding; a parsing, pricing, or sidecar failure cannot alter bytes already sent to the client.
4. Writes sanitized sidecar v1 files atomically: same-directory temp file, flush, close, rename to immutable final name. Never opens SQLite or calls the server; writes files only.
5. Body-free live status signal crosses the process boundary through files only.
6. `node --test` coverage: fixture-driven forwarding fidelity (proxied bytes equal direct upstream fixtures), usage extraction from streaming and non-streaming Responses payloads, atomic-write behavior, failure-isolation (bad upstream payload never breaks the stream).
7. `pnpm verify` green.

## Out of scope

Server ingest (task 04); body capture (task 09).
