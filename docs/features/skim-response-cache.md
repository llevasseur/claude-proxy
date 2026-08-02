---
type: feature
title: Skim response cache
description: An opt-in, byte-exact response cache in the proxy that replays a repeat streamed /v1/messages reply from disk with zero upstream call, plus a dashboard page measuring hit-rate and dollars saved.
tags: [backend, dashboard, usage]
timestamp: 2026-07-24
---

# Skim response cache

## Summary

An opt-in, byte-exact proxy **response** cache. A streamed `POST /v1/messages`
whose bytes match a prior body replays its stored SSE with **zero** Anthropic API call,
saving input, output, and latency. Every request records a `skim` audit-sidecar
block; the [dashboard](admin-dashboard-for-claude-proxy-usage.md) aggregates hit rate
and estimated savings. It is **off by default** unless `SKIM_CACHE` is set. See
[map-proxy-skim](../wayfinder/map-proxy-skim.md).

## Motivation

Anthropic's **prefix cache** is server-side transformer KV-state on its GPUs that saves
~90% of *input* tokens and cannot move into the proxy without self-hosting. The skim is an
**app-layer response cache**: it caches output, skips the whole request, and works
cross-session.

[Cacheability research](../wayfinder/research-002-cacheability.md) measured 1,787
bodies: byte-exact hits were **~1.1% overall and ~0.6% for replayable streamed
traffic** because session UUIDs, git status, dates, and `tool_result` output salt
requests. Yet ~99% fall into ~63 recurring shapes. Byte-exact keying is the safe
floor; instrumentation determines whether a smarter key is worthwhile.

## Behavior

- **Off by default** — `proxy/skim.mjs` reads `SKIM_CACHE` once at startup and only treats
  `1`, `true`, `yes`, or `on` (case-insensitive) as enabled. Unset means `cacheable()`
  returns `false` for everything: nothing stored, nothing served.
- **Env vars** — `SKIM_CACHE` (enable flag, default off), `SKIM_TTL_MS` (entry lifetime,
  default `3600000` = 1 hour), `SKIM_DIR` (cache directory, default `<LOG_DIR>/../.skim-cache`,
  a sibling of the logs dir). Zero runtime dependencies — Node built-ins only.
- **The gate** — `cacheable()` admits a request only when all three hold: the skim is
  enabled, the path contains `/v1/messages`, and the parsed body has `stream === true`
  (replay can only re-emit raw SSE, so non-streaming replies are never cached).
  `proxy.mjs` separately excludes `count_tokens` via `isTokenCount` before calling the gate.
- **Cache key** — `sha256` of the exact forwarded request body (`keyFor(rawBody)`), taken
  *after* the proxy's own tool/reminder stripping so the key matches what was actually sent.
  The model is inside the body, so it is part of the key by construction. Any one-byte
  difference is a different key, hence a miss.
- **On disk** — two files per entry in the cache directory: `<key>.sse` (the raw response
  bytes) and `<key>.meta.json` (`statusCode`, `contentType`, `inputTokens`, `model`,
  `storedAt`). Writes are best-effort — a failed write is swallowed so it can never break
  the proxy.
- **TTL is a read-time check** — `lookup()` returns `null` when `Date.now() - storedAt`
  exceeds the TTL, and an expired entry is treated as an ordinary miss: the request goes
  upstream and the entry is only replaced if that identical key recurs. Expired files are
  never deleted.
- **Hit path: zero upstream call** — the proxy writes the stored status and content-type,
  ends the response with the stored bytes, and returns *before* any `https.request` is
  made. It still writes the full log set (`.request.txt`, `.md`, `.audit.json`) and appends
  to the session transcript, then logs
  `[agent-proxy] SKIM HIT <first 8 of key> · saved ~N input tok · logs/<base>.md`.
- **Miss path stores only clean successes** — on the normal pass-through, `skim.store()`
  runs only when the request was cacheable *and* the upstream status was exactly `200`.
  A miss changes nothing about the bytes Claude Code receives.
- **Sidecar instrumentation on every request** — `writeAuditSidecar` always emits a `skim`
  block with exactly four fields: `enabled`, `servedFromCache`, `savedInputTokens`, and
  `cacheKey` (`null` when the request wasn't cacheable). Legacy or malformed blocks are
  normalized to an all-off default in `packages/core`, so old sidecars count as
  skim-disabled traffic.
- **Aggregation** (`packages/core/src/skim.ts`) — `computeSkimDigest` walks a day's
  sidecars and produces `requestCount`, `enabledRequests`, `hits`, `misses`, `hitRate`
  (hits ÷ enabled requests, `0` with no enabled traffic — disabled requests stay out of the
  denominator), `savedInputTokens`, `estSavedUsd`, and `topShapes`. Dollars saved are
  estimated per hit as `savedInputTokens / 1e6 × priceFor(model).input` — the sidecar's own
  model at that model's **input**-token rate, a conservative floor that ignores the output
  tokens a hit also avoids. `skimDigestsByDay` buckets by the dashboard's shared reporting
  zone (`America/New_York`, EST/EDT), oldest first, so Skim and the Overview/Trends windows
  roll over together at Eastern midnight.
- **Shapes** — any request with a `cacheKey` accumulates into a per-key `SkimShape`
  (`requests`, `hits`, `savedInputTokens`, `estSavedUsd`, plus a `requestText` label),
  ranked by request count. `requestText` is **not** a sidecar field: `server/src/logs.ts`
  enriches each sidecar with `skimRequestText` under the `includeSkimRequests` flag by
  reading the sibling `.request.txt` and extracting the latest user text, so a key with no
  surviving request log simply has no label.
- **Endpoints** — `GET /api/skim?date=YYYY-MM-DD` (one day, defaults to today; invalid
  dates are ignored) and `GET /api/skim/trend?days=N` (`N` defaults to 14 and is clamped to
  1–365). Both enable the request-text enrichment; `/api/skim` and the trend's cross-window
  `topShapes` request `topN: 50`, while the trend's per-day `digests` keep the default 12.
- **Skim page** (`/skim`) — a 7/14/30-day window selector and four stat tiles:
  **Hit rate (today)** (with `hits / enabled` underneath), **Saved today**,
  **Saved (Nd)**, and **Saved input tokens (today)**. Two charts follow —
  **Hit-rate over time** and **Cumulative $ saved** (a running sum of daily `estSavedUsd`)
  — then **Top repeated request shapes (Nd)** as a bar chart of the top 12 keys by request
  count, and a **By shape** table with columns **Cache key**, **Request**, **Requests**,
  **Hits**, **Saved tokens**, and **Est. saved**. The **Request** cell expands to the
  captured user text, or reads *"Request log unavailable"* when the log is gone. With no
  captured activity the page shows *"No skim activity captured in the last N days."*

Data path: `proxy/skim.mjs` (gate, key, store, replay) → the `.audit.json` sidecar's
`skim` block → `packages/core/src/skim.ts` (`computeSkimDigest` / `skimDigestsByDay`) →
`server` (`/api/skim`, `/api/skim/trend`) → `apps/admin` (the **Skim** page). Only the proxy
side touches live traffic; everything downstream is read-only over captured sidecars.

## Acceptance criteria

- [x] The skim is off unless `SKIM_CACHE` is truthy (`1|true|yes|on`); with it unset the
      proxy neither stores nor serves anything.
- [x] Only streamed `/v1/messages` requests are cacheable; `count_tokens` and non-streaming
      requests are excluded.
- [x] The cache key is `sha256` of the exact forwarded request body, so only a byte-identical
      repeat can hit.
- [x] A hit replays the stored SSE and returns before any upstream request is issued, logging
      `SKIM HIT` with the key prefix and the input tokens saved.
- [x] A miss leaves the proxy's bytes unchanged — the response is passed through untouched,
      and a failed cache write never breaks the request.
- [x] Entries are stored only for upstream `200`s, and an entry older than `SKIM_TTL_MS` is
      treated as a miss.
- [x] Every audit sidecar carries a `skim` block with `enabled`, `servedFromCache`,
      `savedInputTokens`, and `cacheKey`; malformed and legacy blocks degrade to
      skim-disabled rather than aborting a digest.
- [x] `computeSkimDigest` reports hit-rate over enabled traffic only, sums saved input
      tokens, estimates dollars at each model's input rate, and ranks repeated shapes —
      all unit-tested in `packages/core/test/skim.test.ts` (empty input, hit/miss counting,
      disabled-request exclusion, dollar estimation, shape ranking, request-text retention,
      `topN`, malformed sidecars, and reporting-zone day splitting, including a
      late-evening request whose UTC date is already the next day).
- [x] `GET /api/skim` and `GET /api/skim/trend` serve the digests, and `/skim` charts
      hit-rate, cumulative dollars saved, and top repeated shapes.

## Open questions

- **The semantic skim layer is not built.** Matching "same or similar task" needs an
  embedding/similarity threshold, scope keys (cwd, host, git HEAD), and a policy for
  answer-irrelevant volatility (`session_id`, embedded dates, `cache_control`). Research
  favors small stateless utility calls—quota ping, CLAUDE.md classifier, title/label
  jobs—not 64k-token agent turns.
- **`SKIM_MAX_ENTRIES` and eviction were proposed but never implemented.**
  [Correctness guardrails](../wayfinder/decision-004-guardrails.md) recommends a max entry
  count with LRU/oldest-first eviction plus opportunistic deletion of expired files; none of
  it exists in `proxy/skim.mjs`. The TTL is enforced on read only, expired files are never
  removed, and the cache directory therefore grows unbounded.
- **The `tool_result` refusal is proposal-only.** Nothing in `cacheable()` inspects message
  content, so a request whose messages carry `tool_result` snapshots of now-changed state is
  cached and replayable like any other. Decision 004 names this the highest-value exclusion
  to add, alongside a stream-completeness check (a truncated-but-`200` SSE is currently
  stored as if whole) — and that whole decision doc is still `status: proposed`, awaiting
  human ratification.
- **Default TTL.** Decision 004 says 1 hour is too long when keys cannot distinguish
  stable from live-state questions and suggests ~5–15 minutes; the value is unratified.

## Related

- [Admin dashboard for claude-proxy usage](admin-dashboard-for-claude-proxy-usage.md)
- [Map: proxy skim](../wayfinder/map-proxy-skim.md)
- [Cacheability research](../wayfinder/research-002-cacheability.md)
- [Correctness guardrails](../wayfinder/decision-004-guardrails.md)
