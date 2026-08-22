# Task 02 — Core usage, pricing and sidecar domain

## Goal

Build `@ox-alpha-proxy/core`: the deterministic domain that normalizes OpenAI
Responses usage, prices it in pico-dollars, defines sanitized sidecar v1, and
aggregates Today. Blocked by task 01.

## Criteria

1. Normalized immutable usage value: required input, output, total headline tokens; cached-input and reasoning-output detail as subsets that never increase totals.
2. Streaming and non-streaming Responses adapters select the final authoritative usage object and feed one shared normalizer. Port selection mechanics from codex-proxy `packages/core/src` where docs are silent; cite the file in a code comment or plan note.
3. Pricing: explicit USD-per-million decimal strings by model and category; integer pico-dollar math; catalogue carries a version. Missing model or consumed-category rate returns `cost: null` with a typed reason per ADR 0003. Rates ported from the codex-proxy catalogue — never invented.
4. Sanitized sidecar v1 types and strict validator exactly per `docs/specs/bike-architecture.md` field table; unknown fields fail; no body/prompt/header slot exists.
5. Today aggregation over sidecar records with half-open report-timezone day boundaries, DST-aware; timezone and clock passed in explicitly; no Node imports, no env access anywhere in core.
6. Vitest coverage for each behavior above, including DST spring/autumn days, unpriced propagation, unknown-field rejection, and detail-subset invariants.
7. `pnpm verify` green; core still dependency-free and deterministic.

## Out of scope

Proxy, server, admin code; history/trends (task 06).
